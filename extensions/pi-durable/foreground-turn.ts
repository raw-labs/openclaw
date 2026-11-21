import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import {
  buildEmbeddedAttemptToolRunContext,
  buildEmbeddedForegroundPromptContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import { completeSimple, type AssistantMessage, type Message } from "openclaw/plugin-sdk/llm";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createPiModelPreview } from "./live-model.js";
import { preparePiNodeWorkspace } from "./node-workspace.js";
import { mirrorPiDurableAnswer, type PiTurnYield, type SessionGeneration } from "./notices.js";
import { piHookContext, preparePiPrompt } from "./prompt.js";
import { attachPiSteering } from "./steering.js";
import { createPiTurnLifecycle } from "./turn-lifecycle.js";
import { createPiToolExchangeRecorder, createPiTurnToolRunner } from "./turn-tools.js";
import {
  piWorkerModel,
  runWorker,
  type PiStartCommand,
  type WorkerResult,
} from "./worker-client.js";

type Attempt = Parameters<AgentHarnessV2["runAttempt"]>[0];

export async function runForegroundPiTurn(options: {
  attempt: Attempt;
  api: OpenClawPluginApi;
  generation: SessionGeneration;
  databasePath: string;
  seed?: Message[];
  checkpoint?: PiStartCommand["checkpoint"];
  serviceSignal: AbortSignal;
  log: OpenClawPluginApi["logger"];
  approvalTool: string;
  turnApprovalId: string;
  delegatedTools: string[];
  admitStart: (command: PiStartCommand) => Promise<PiStartCommand>;
  cancelInterrupted: () => Promise<void>;
}) {
  const {
    attempt,
    api,
    generation,
    databasePath,
    seed,
    checkpoint,
    serviceSignal,
    log,
    approvalTool,
    turnApprovalId,
    delegatedTools,
    admitStart,
    cancelInterrupted,
  } = options;
  const { agentId, sessionId, sessionKey } = generation;
  const host = attempt.hostCapabilities;
  const stop = new AbortController();
  const signal = AbortSignal.any(
    attempt.abortSignal
      ? [serviceSignal, attempt.abortSignal, stop.signal]
      : [serviceSignal, stop.signal],
  );
  if (attempt.sandbox?.backendId === "node" && attempt.requireWorkspaceOnly) {
    throw new Error(
      "This session requires sandbox isolation. Paired-node workspaces use the node account's permissions.",
    );
  }
  using node = preparePiNodeWorkspace(api, attempt.sandbox, signal, host.assertActive);
  const params = node ? { ...attempt, sandbox: node.sandbox } : attempt;
  const toolYield = new AsyncLocalStorage<{ recorded?: PiTurnYield }>();
  const regularTools = params.disableTools
    ? []
    : await host.createToolSurfaceAsync?.({
        ...buildEmbeddedAttemptToolRunContext(params),
        toolBindings: { ...params.toolBindings, [approvalTool]: delegatedTools },
        config: params.config,
        sandbox: params.sandbox ?? undefined,
        agentId,
        sessionKey,
        sessionId,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        modelProvider: params.provider,
        modelId: params.modelId,
        runId: params.runId,
        onYield(_message, acknowledgment, messageWaitRegistered, handoff) {
          if (handoff?.conditional || handoff?.terminal) {
            throw new Error("This tool requires an immediate or conditional handoff.");
          }
          const current = toolYield.getStore();
          if (current) {
            current.recorded = {
              ...(acknowledgment === undefined ? {} : { acknowledgment }),
              ...(messageWaitRegistered === undefined ? {} : { messageWaitRegistered }),
              ...(handoff?.resumesInPlace ? { resumesInPlace: true } : {}),
            };
          }
        },
      });
  if (!regularTools) {
    throw new Error("OpenClaw could not prepare the Pi Durable tool surface.");
  }
  await using mcp = await host.prepareHostMcpTools?.(regularTools.map(({ name }) => name));
  let tools = [...regularTools, ...(mcp?.tools ?? [])];
  let hookAllow: string[] | undefined;
  const prompt = await preparePiPrompt(
    params,
    generation,
    () => tools.map(({ name }) => name),
    (names) => {
      hookAllow = names;
      const allowed = new Set(names);
      tools = tools.filter(({ name }) => allowed.has(name));
    },
  );
  host.assertActive();
  mcp?.restrictAppTools(hookAllow);
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
  delegatedTools.push(...tools.filter(({ name }) => name !== approvalTool).map(({ name }) => name));
  const route = {
    provider: params.provider,
    modelId: params.modelId,
    ...(params.authProfileId ? { profileId: params.authProfileId } : {}),
  };
  const model = { ...piWorkerModel(params.model), id: route.modelId, provider: route.provider };
  const toolMetas: Awaited<ReturnType<AgentHarnessV2["runAttempt"]>>["toolMetas"] = [];
  let compactionCount = 0;
  let latestAssistant: AssistantMessage | undefined;
  const nextPreview = createPiModelPreview(params, log);
  const recordToolExchange = createPiToolExchangeRecorder(
    generation,
    params.runId,
    params.config,
    host.assertActive,
    log,
  );
  const executeTool = createPiTurnToolRunner(params, recordToolExchange, signal, log);
  const lifecycle = createPiTurnLifecycle({
    ctx: piHookContext(params, [...toolByName.keys()]),
    runId: params.runId,
    sessionId,
    provider: route.provider,
    model: route.modelId,
    sessionFile: params.sessionFile,
    prompt: params.prompt,
    allowFinalPresentation: true,
    assertCurrent: host.assertActive,
  });
  const command = await admitStart({
    action: "start",
    seed,
    checkpoint,
    model,
    route,
    prompt:
      params.finalizePromptForResolvedTools?.({
        prompt: prompt.prompt,
        messageToolAvailable: toolByName.has("message"),
      }) ?? prompt.prompt,
    instructions: prompt.developerInstructions,
    runId: params.runId,
    thinkingLevel: params.thinkLevel,
    images: params.images,
    tools: tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
  });
  const result = await runWorker(
    databasePath,
    command,
    signal,
    async (request, progress) => {
      host.assertActive();
      if (request.kind === "finalize") {
        return await lifecycle.finalize(request.answer);
      }
      if (request.kind === "before-compaction") {
        return await lifecycle.beforeCompaction(request.messages);
      }
      if (request.kind === "after-compaction") {
        compactionCount++;
        host.reportContextAccounting?.({ kind: "compaction" });
        return await lifecycle.afterCompaction(request.messages, request.count);
      }
      if (request.kind === "tool-rejected") {
        const { toolName, toolCallId } = request.result;
        toolMetas.push({ toolName, toolCallId, isError: true });
        return await recordToolExchange(request.assistant, request.result);
      }
      if (request.kind === "admit") {
        const admission = toolByName.get(approvalTool);
        if (!admission) {
          throw new Error("The current tool policy does not allow pi_durable_wait.");
        }
        const receipt = await admission.execute(request.callId, {}, signal);
        const details = receipt.details;
        if (
          !details ||
          typeof details !== "object" ||
          !("id" in details) ||
          details.id !== turnApprovalId
        ) {
          throw new Error("Pi Durable wait was admitted for a different session.");
        }
        return details;
      }
      if (request.kind === "tool") {
        const tool = toolByName.get(request.name);
        if (!tool || tool.name === approvalTool) {
          return {
            output: [{ type: "text", text: "This tool is unavailable in the current turn." }],
            isError: true,
          };
        }
        const turnYield: { recorded?: PiTurnYield } = {};
        const receipt: (typeof toolMetas)[number] = {
          toolName: tool.name,
          toolCallId: request.callId,
        };
        toolMetas.push(receipt);
        const toolResult = await toolYield.run(turnYield, () =>
          executeTool(tool, request.callId, request.args, latestAssistant),
        );
        receipt.isError = toolResult.isError;
        return turnYield.recorded && !toolResult.isError
          ? { ...toolResult, details: { openclawYield: turnYield.recorded } }
          : toolResult;
      }
      if (request.kind !== "model") {
        throw new Error("A Pi Durable approval is required before checking the session.");
      }
      const binding = host.bindModelExecution?.({
        provider: route.provider,
        model: route.modelId,
      });
      const compaction = request.purpose === "compaction";
      const preview = compaction ? undefined : nextPreview();
      try {
        lifecycle.modelInput(request.context, request.purpose);
        const message = await completeSimple(
          params.model,
          request.context,
          {
            apiKey: params.resolvedApiKey,
            sessionId,
            maxTokens: request.maxTokens,
            ...(compaction ? { cacheRetention: "none" } : {}),
            reasoning:
              request.reasoning === "adaptive"
                ? "medium"
                : request.reasoning === "ultra"
                  ? "max"
                  : request.reasoning,
            signal: binding ? AbortSignal.any([signal, binding.signal]) : signal,
          },
          () => {
            host.assertActive();
            binding?.assertCurrent();
          },
          preview
            ? async (event) => {
                signal.throwIfAborted();
                progress(event);
                await preview(event);
              }
            : undefined,
        );
        lifecycle.modelOutput(message);
        if (!compaction) {
          latestAssistant = message;
          if (
            compactionCount > 0 &&
            message.stopReason !== "error" &&
            message.stopReason !== "aborted"
          ) {
            host.reportContextAccounting?.({ kind: "model", usage: message.usage });
          }
        }
        host.reportOutputTokens?.(message.usage.output);
        return message;
      } finally {
        binding?.release();
      }
    },
    (input) => {
      const detach = attachPiSteering(params, input, stop);
      log.debug?.(`Pi Durable steering attachment ${detach ? "registered" : "declined"}.`);
      return detach;
    },
  ).catch(async (error: unknown): Promise<WorkerResult> => {
    if (!signal.aborted || serviceSignal.aborted) {
      throw error;
    }
    await cancelInterrupted();
    return { wait: { state: "cancelled" } } satisfies WorkerResult;
  });
  const transcript = await mirrorPiDurableAnswer(params, generation, result);
  if (result.wait.state !== "waiting") {
    await lifecycle.end(
      result.wait.state === "completed" || result.wait.state === "yielded",
      result.assistant,
      {
        completedTurnSource: transcript?.completedTurnSource,
        foregroundPromptContext: buildEmbeddedForegroundPromptContext(
          { ...params, agentId },
          params.agentDir ?? resolveAgentDir(params.config ?? {}, agentId),
        ),
      },
    );
  }
  if (result.wait.state === "yielded" && !result.wait.resumesInPlace) {
    params.replyOperation?.yield();
  }
  return {
    ...result,
    toolMetas,
    compactionCount,
    transcript,
    finalPresentation: lifecycle.finalPresentation,
  };
}
