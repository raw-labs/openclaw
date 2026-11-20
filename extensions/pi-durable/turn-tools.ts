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
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { appendSessionTranscriptMessageByIdentityStrict } from "openclaw/plugin-sdk/session-transcript-runtime";
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

export function createPiTurnToolRunner(
  attempt: Attempt,
  generation: SessionGeneration,
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
  const recordAppMessage = async (
    message: AssistantMessage | ToolResultMessage,
    toolCallId: string,
  ) => {
    const prepared = runAgentHarnessBeforeMessageWriteHook({ ...identities, message });
    if (prepared) {
      await appendSessionTranscriptMessageByIdentityStrict({
        ...generation,
        config: attempt.config,
        runId,
        beforeFreshMessageCommit: host.assertActive,
        idempotencyLookup: "scan",
        updateMode: "inline",
        message: {
          ...prepared,
          idempotencyKey: `pi-durable:app:${runId}:${toolCallId}:${message.role}`,
        },
      });
    }
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
          (part) => part.type === "text" || part.type === "image",
        );
        if (isRecord(observerResult.details) && observerResult.details.mcpAppPreview) {
          const modelCall = assistant?.content.find(
            (part) => part.type === "toolCall" && part.id === toolCallId && part.name === toolName,
          );
          if (assistant && modelCall?.type === "toolCall") {
            // The normal App reconstruction path reads the exact call/result pair.
            await recordAppMessage(
              {
                ...assistant,
                content: [{ ...modelCall, arguments: executedArguments }],
                usage: makeZeroUsageSnapshot(),
              },
              toolCallId,
            );
          }
          const { mcpAppPreview, mcpServer, mcpTool, structuredContent } = observerResult.details;
          await recordAppMessage(
            {
              role: "toolResult",
              toolCallId,
              toolName,
              isError,
              timestamp: Date.now(),
              content: output,
              details: { mcpAppPreview, mcpServer, mcpTool, structuredContent },
            },
            toolCallId,
          );
        }
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
