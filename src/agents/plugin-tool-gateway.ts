import { getAgentToolAssistantTurnId } from "../../packages/agent-core/src/tool-execution-context.js";
import { captureExecRequestOwners } from "../infra/exec-request-context.js";
import type { OpenClawPluginToolContext } from "../plugins/tool-types.js";
import { resolveReplyRunForCurrentSessionId } from "../sessions/session-controller.identity.js";
import { findSessionControllerOperationByRunId } from "../sessions/session-controller.queries.js";
import type { OpenClawPluginToolOptions } from "./openclaw-tools.plugin-context.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  callInProcessGatewayTool,
} from "./tools/in-process-gateway.js";
import { handoffSessionTool } from "./tools/session-tool-handoff.js";

/** Capture operation custody once; factories receive no raw caller or sandbox. */
export function preparePluginToolGatewayCapability(
  options: OpenClawPluginToolOptions | undefined,
  context: Pick<OpenClawPluginToolContext, "agentId" | "sessionKey">,
) {
  const clientCaps = Object.freeze([...(options?.clientCaps ?? [])]);
  let operation = options?.runId ? findSessionControllerOperationByRunId(options.runId) : undefined;
  if (options?.runId === undefined && options?.sessionId) {
    const current = resolveReplyRunForCurrentSessionId(options.sessionId);
    operation = current.kind === "one" ? current.operation : undefined;
  }
  const requestOwners = captureExecRequestOwners(options ?? {});
  return (
    assertInvocationCurrent: () => void,
    pluginSignal?: AbortSignal,
    gatewayMethods: readonly string[] = [],
  ): NonNullable<OpenClawPluginToolContext["gateway"]> => {
    const ownedMethods = new Set(gatewayMethods);
    const assertOwnedMethod = (method: string): void => {
      if (!ownedMethods.has(method)) {
        throw new Error("Plugin tools require an owned Gateway method.");
      }
    };
    const signalFor = (signal?: AbortSignal) =>
      AbortSignal.any(
        [options?.abortSignal, pluginSignal, signal].filter((value): value is AbortSignal =>
          Boolean(value),
        ),
      );
    const currentCaller = () => {
      assertInvocationCurrent();
      pluginSignal?.throwIfAborted();
      const caller = getGatewayToolCallerIdentity();
      if (
        !caller?.agentId ||
        !caller.sessionKey ||
        (context.agentId !== undefined && caller.agentId !== context.agentId) ||
        (context.sessionKey !== undefined && caller.sessionKey !== context.sessionKey)
      ) {
        throw new Error("Plugin Gateway operations require their current admitted agent session.");
      }
      return caller;
    };
    return {
      get agentId() {
        return currentCaller().agentId;
      },
      get sessionKey() {
        return currentCaller().sessionKey;
      },
      clientCaps,
      idempotencyKey(toolCallId) {
        currentCaller();
        const turnId = getAgentToolAssistantTurnId();
        return turnId ? `${turnId}:${toolCallId}` : toolCallId;
      },
      async call<T>(
        method: string,
        params: Record<string, unknown>,
        request: { signal?: AbortSignal; timeoutMs?: number } = {},
      ) {
        const caller = currentCaller();
        assertOwnedMethod(method);
        const signal = signalFor(request.signal);
        signal.throwIfAborted();
        return await withGatewayToolCallerIdentity(caller, () =>
          callInProcessGatewayTool<T>(method, params, {
            ...request,
            signal,
            sessionMutationCommitGuard: assertInvocationCurrent,
          }),
        );
      },
      async handoff(request) {
        const caller = currentCaller();
        assertOwnedMethod(request.method);
        signalFor(request.signal).throwIfAborted();
        return await handoffSessionTool({
          ...request,
          sessionId: options?.sessionId,
          runId: options?.runId,
          operation,
          requestOwners,
          onYield: options?.onYield,
          senderIsOwner: options?.senderIsOwner,
          withholdFailureReason: true,
          run: ({ assertCurrent, signal }) =>
            withGatewayToolCallerIdentity(
              { agentId: caller.agentId, sessionKey: caller.sessionKey },
              () =>
                callAgentToolGatewayRequest({
                  method: request.method,
                  params: request.params,
                  sessionMutationCommitGuard: () => {
                    assertCurrent();
                    pluginSignal?.throwIfAborted();
                  },
                  signal: pluginSignal ? AbortSignal.any([signal, pluginSignal]) : signal,
                  timeoutMs: null,
                }),
            ),
          formatResult(payload) {
            pluginSignal?.throwIfAborted();
            return request.formatResult(payload);
          },
        });
      },
    };
  };
}
