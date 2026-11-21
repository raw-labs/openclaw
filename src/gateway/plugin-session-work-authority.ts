import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginServiceSessionWorkContextV1 } from "../plugins/service-session-work.types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** Host-only scope. Never assembled from RPC parameters or plugin-owned state. */
export type PluginSessionWorkAuthority = PluginServiceSessionWorkContextV1 & {
  pluginId: string;
  context: GatewayRequestContext;
  assertToolAllowed: (name: string) => void;
  nodeTool?: string;
};
const current = new AsyncLocalStorage<PluginSessionWorkAuthority>();
export const readPluginSessionWorkAuthority = () => current.getStore();
export function runWithPluginSessionWorkAuthority<T>(
  authority: PluginSessionWorkAuthority,
  run: () => T,
): T {
  authority.assertCurrent();
  return current.run(authority, run);
}

/** A host-built placement tool can borrow its own declared node command. */
export function withPluginSessionWorkNodeTool<T>(name: string, run: () => T): T {
  const authority = current.getStore();
  if (!authority) {
    return run();
  }
  authority.assertToolAllowed(name);
  return current.run({ ...authority, nodeTool: name }, run);
}

/** Scheduled service work must acquire a fresh borrow instead of inheriting a settled one. */
export function runOutsidePluginSessionWorkAuthority<T>(run: () => T): T {
  return current.exit(run);
}

/** Apply the accepted operation's ceiling before any in-process method dispatch. */
export function resolvePluginSessionWorkDispatch({
  method,
  params,
  context,
  scopedPluginId,
  pluginRuntimeOwnerId,
}: {
  method: string;
  params: unknown;
  context: GatewayRequestContext;
  scopedPluginId?: string;
  pluginRuntimeOwnerId?: string;
}): PluginSessionWorkAuthority | undefined {
  const service = readPluginSessionWorkAuthority();
  if (service) {
    service.assertCurrent();
    if (
      context !== service.context ||
      scopedPluginId?.trim() !== service.pluginId ||
      (pluginRuntimeOwnerId !== undefined && pluginRuntimeOwnerId !== service.pluginId)
    ) {
      throw new Error("Accepted service work cannot target another plugin or Gateway");
    }
    const request = isRecord(params) ? params : {};
    if (method === "node.invoke" && service.nodeTool) {
      const scope = getPluginRuntimeGatewayRequestScope();
      const owner = scope?.nodePlacementGrantAuthority;
      const commands = getRegisteredAgentHarness(service.pluginId)?.harness.cloudPlacement
        ?.devicePlacement?.requiredNodeCommands;
      if (
        !scope?.invokeWithSessionNodeAuthority ||
        pluginRuntimeOwnerId !== service.pluginId ||
        request.sessionKey !== service.target.sessionKey ||
        owner?.sessionKey !== service.target.sessionKey ||
        owner.agentId !== service.target.agentId ||
        typeof request.command !== "string" ||
        !commands?.includes(request.command)
      ) {
        throw new Error("Accepted service work cannot invoke this node placement command.");
      }
      service.assertToolAllowed(service.nodeTool);
      return service;
    }
    const requiredTool =
      method === "tools.invoke"
        ? typeof request.name === "string"
          ? request.name
          : undefined
        : context.getGatewayMethodRegistry?.()?.getSessionAccess?.(method)?.requiredTool;
    if (!requiredTool) {
      throw new Error("Accepted service work requires a registered session-tool boundary");
    }
    if (
      request.sessionKey !== service.target.sessionKey ||
      request.agentId !== service.target.agentId
    ) {
      throw new Error("Accepted service work cannot target another conversation");
    }
    service.assertToolAllowed(requiredTool);
  }
  return service;
}
