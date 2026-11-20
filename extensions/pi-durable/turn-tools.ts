import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import {
  emitAgentHarnessAttemptEvent,
  makeZeroUsageSnapshot,
} from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import {
  createAgentToolResultMiddlewareRunner,
  projectAgentToolActivity,
  runAgentHarnessAfterToolCallHook,
  runAgentHarnessBeforeMessageWriteHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createAgentHarnessToolExecutionBoundaryRegistry,
  runAgentHarnessToolInvocation,
} from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import {
  validateToolArguments,
  type AssistantMessage,
  type ToolResultMessage,
} from "openclaw/plugin-sdk/llm";
import type {
  OpenClawPluginApi,
  PluginServiceSessionWorkContextV1,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  appendSessionTranscriptMessagesByIdentity,
  publishSessionTranscriptUpdateByIdentity,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SessionGeneration } from "./notices.js";

type Attempt = Parameters<AgentHarnessV2["runAttempt"]>[0];
type Tool = Awaited<
  ReturnType<NonNullable<Attempt["hostCapabilities"]["createToolSurfaceAsync"]>>
>[number];

export function toolOutput(content: readonly { type: string }[]) {
  return { output: content.filter(({ type }) => type === "text" || type === "image") };
}

export function toolFailure(error: unknown) {
  return {
    output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export async function invokeRecoveredPiGatewayTool(
  api: OpenClawPluginApi,
  target: Pick<SessionGeneration, "agentId" | "sessionKey">,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const receipt = await api.runtime.gateway.request<
    | { ok: true; output: { content: readonly { type: string }[] } }
    | { ok: false; error: { message: string } }
  >(
    "tools.invoke",
    { name, args, agentId: target.agentId, sessionKey: target.sessionKey },
    { signal },
  );
  if (!receipt.ok) {
    throw new Error(receipt.error.message);
  }
  return receipt.output;
}

export function createPiToolExchangeRecorder(
  generation: SessionGeneration,
  runId: string,
  config: Attempt["config"],
  assertActive: () => void,
  log: OpenClawPluginApi["logger"],
) {
  const { agentId, sessionId, sessionKey } = generation;
  const identities = { agentId, sessionId, sessionKey, runId };
  return async (
    assistant: AssistantMessage | undefined,
    result: ToolResultMessage,
    args?: Record<string, unknown>,
  ) => {
    const { toolName, toolCallId } = result;
    const call = assistant?.content.find(
      (part) => part.type === "toolCall" && part.id === toolCallId && part.name === toolName,
    );
    if (!assistant || call?.type !== "toolCall") {
      return;
    }
    const messages = [
      {
        ...assistant,
        content: [{ ...call, arguments: args ?? call.arguments }],
        usage: makeZeroUsageSnapshot(),
      },
      result,
    ].flatMap((message) => {
      const prepared = runAgentHarnessBeforeMessageWriteHook({ ...identities, message });
      return prepared
        ? [
            {
              runId,
              beforeFreshMessageCommit: assertActive,
              idempotencyLookup: "scan" as const,
              message: {
                ...prepared,
                idempotencyKey: `pi-durable:tool:${runId}:${toolCallId}:${message.role}`,
              },
            },
          ]
        : [];
    });
    if (messages.length !== 2) {
      return;
    }
    try {
      const appended = await appendSessionTranscriptMessagesByIdentity({
        ...generation,
        config,
        messages,
      });
      if (
        isRecord(result.details) &&
        result.details.mcpAppPreview &&
        appended.some((row) => row.appended)
      ) {
        await publishSessionTranscriptUpdateByIdentity(generation);
      }
    } catch {
      assertActive();
      // The tool has already settled. A failed projection must not ask the model to retry it.
      log.warn("Pi Durable could not record a tool exchange in the OpenClaw transcript.");
    }
  };
}

export async function recordRecoveredPiToolRejection(
  api: OpenClawPluginApi,
  current: PluginServiceSessionWorkContextV1,
  runId: string,
  rejection: { assistant: AssistantMessage; result: ToolResultMessage },
) {
  const generation = await api.runtime.system.captureSessionGeneration(current.target);
  current.assertCurrent();
  if (
    generation?.sessionId !== current.target.sessionId ||
    generation.lifecycleRevision !== (current.target.lifecycleRevision ?? null)
  ) {
    return;
  }
  await createPiToolExchangeRecorder(
    generation,
    runId,
    api.runtime.config.current({ clone: true }),
    current.assertCurrent,
    api.logger,
  )(rejection.assistant, rejection.result);
}

export function createPiTurnToolRunner(
  attempt: Attempt,
  recordToolExchange: ReturnType<typeof createPiToolExchangeRecorder>,
  signal: AbortSignal,
  log: OpenClawPluginApi["logger"],
) {
  const { agentId, sessionId, sessionKey, runId, workspaceDir, hostCapabilities: host } = attempt;
  const identities = { agentId, sessionId, sessionKey, runId };
  const boundaries = createAgentHarnessToolExecutionBoundaryRegistry();
  const middleware = createAgentToolResultMiddlewareRunner({ ...identities, runtime: "openclaw" });
  const diagnostics = {
    label: "Pi Durable",
    log: { debug: (message: string) => log.debug?.(message) },
  };
  return async function execute(
    tool: Tool,
    toolCallId: string,
    args: Record<string, unknown>,
    assistant?: AssistantMessage,
  ) {
    const toolName = tool.name;
    const startedAt = Date.now();
    const emit = (facts: Parameters<typeof projectAgentToolActivity>[0]) =>
      emitAgentHarnessAttemptEvent(
        attempt,
        { stream: "item", data: projectAgentToolActivity(facts) },
        diagnostics,
      );
    return await runAgentHarnessToolInvocation({
      tool,
      call: { toolCallId, toolName, arguments: args, cwd: workspaceDir },
      runId,
      startedAt,
      signal,
      boundaries,
      assertCurrent: host.assertActive,
      async beforeExecute() {
        await emit({ toolCallId, name: toolName, phase: "start", args });
      },
      validateArguments(value) {
        if (!isRecord(value)) {
          throw new Error(`Expected an object for ${toolName} arguments.`);
        }
        validateToolArguments(tool, {
          type: "toolCall",
          id: toolCallId,
          name: toolName,
          arguments: value,
        });
      },
      applyMiddleware: (event) => middleware.applyToolResultMiddleware(event),
      onExecutionResult({ rawResult, rawIsError, executedArguments }) {
        attempt.observeToolTerminal?.({
          toolCallId,
          toolName,
          arguments: executedArguments,
          result: rawResult,
          executionStarted: true,
          outcome: rawIsError ? "failure" : "success",
        });
      },
      async onResult({ result, observerResult, isError, executedArguments }) {
        host.assertActive();
        await runAgentHarnessAfterToolCallHook({
          ...identities,
          toolName,
          toolCallId,
          startedAt,
          result: observerResult,
          startArgs: executedArguments,
        });
        host.assertActive();
        const output = result.content.filter(
          (part): part is ToolResultMessage["content"][number] =>
            part.type === "text" || part.type === "image",
        );
        const app = observerResult.details;
        await recordToolExchange(
          assistant,
          {
            role: "toolResult",
            toolCallId,
            toolName,
            isError,
            timestamp: Date.now(),
            content: output,
            ...(isRecord(app) && app.mcpAppPreview
              ? {
                  details: {
                    mcpAppPreview: app.mcpAppPreview,
                    mcpServer: app.mcpServer,
                    mcpTool: app.mcpTool,
                    structuredContent: app.structuredContent,
                  },
                }
              : {}),
          },
          executedArguments,
        );
        await emit({
          toolCallId,
          name: toolName,
          phase: "result",
          args: executedArguments,
          result: observerResult,
          status: isError ? "failed" : "completed",
        });
        return { output, isError };
      },
      async onError({ error, executedArguments, boundary }) {
        signal.throwIfAborted();
        host.assertActive();
        const message = error instanceof Error ? error.message : String(error);
        attempt.observeToolTerminal?.({
          toolCallId,
          toolName,
          arguments: executedArguments,
          result: error,
          executionStarted: boundary.executionStarted,
          outcome: "failure",
        });
        await runAgentHarnessAfterToolCallHook({
          ...identities,
          toolName,
          toolCallId,
          startedAt,
          error: message,
          startArgs: executedArguments,
        });
        if (boundary.executionStarted) {
          await recordToolExchange(
            assistant,
            {
              role: "toolResult",
              toolCallId,
              toolName,
              isError: true,
              timestamp: Date.now(),
              content: [{ type: "text", text: message }],
            },
            executedArguments,
          );
        }
        await emit({
          toolCallId,
          name: toolName,
          phase: "result",
          args: executedArguments,
          status: "failed",
        });
        return { output: [{ type: "text" as const, text: message }], isError: true };
      },
    });
  };
}
