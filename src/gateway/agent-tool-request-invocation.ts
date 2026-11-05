import { AsyncLocalStorage } from "node:async_hooks";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { pluginInstanceInvocation } from "../plugins/plugin-instance-invocation.js";
import { capturePluginLifecycleAuthority } from "../plugins/registry-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";

/** Project the current tool authority, never the raw caller or a caller supplied by the plugin. */
export function captureGatewayAgentToolInvocation(
  toolName: string,
  restrictions: { signal?: AbortSignal; sessionMutationCommitGuard?: () => void } = {},
) {
  const scope = getPluginRuntimeGatewayRequestScope();
  const client = scope?.client;
  const invocation = pluginInstanceInvocation.getStore();
  const inInvocation = AsyncLocalStorage.snapshot();
  const caller = client?.internal?.syntheticClient ? getGatewayToolCallerIdentity() : undefined;
  const assertCaller = caller && captureGatewayToolCallerAssertion();
  const assertToolAllowed = caller?.assertToolAllowed;
  const registry = scope?.pluginRegistry;
  const record = registry?.plugins.find((plugin) => plugin.id === scope?.pluginId);
  const pluginCurrent =
    registry &&
    record &&
    capturePluginLifecycleAuthority(registry, record, { scopedRuntime: true });
  if (
    !scope?.pluginId ||
    !caller ||
    !assertCaller ||
    !assertToolAllowed ||
    !pluginCurrent ||
    client?.internal?.pluginRuntimeOwnerId !== scope.pluginId
  ) {
    return undefined;
  }
  const signal = AbortSignal.any(
    [
      scope.signal,
      restrictions.signal,
      getAsyncWorkSignal(),
      ...(caller.approvalSignals ?? []),
    ].filter((value): value is AbortSignal => value !== undefined),
  );
  const assertCurrent = () => {
    assertCaller();
    assertToolAllowed(toolName);
    restrictions.sessionMutationCommitGuard?.();
    signal.throwIfAborted();
    if (
      (invocation && !inInvocation(() => invocation.instance.hasActiveCall)) ||
      !pluginCurrent() ||
      scope.hasCurrentClientAuthority?.() === false
    ) {
      throw new Error("Agent tool request authority is no longer active.");
    }
  };
  return Object.freeze({ agentId: caller.agentId, signal, assertCurrent });
}
