import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextLifetime,
} from "./gateway-context-binding.js";

/** Stable identity for plugin-owned service state; returning only the signal cannot abort the host. */
export function getGatewayServiceLifetime(
  context: Pick<GatewayRequestContext, "resolveGatewayContext">,
): AbortSignal {
  const resolve = context.resolveGatewayContext;
  const owner = resolve && getCanonicalGatewayContextResolver(resolve);
  if (!owner || !resolve?.()) {
    throw new Error("Gateway service owner is unavailable.");
  }
  const signal = getGatewayContextLifetime(owner).signal;
  signal.throwIfAborted();
  return signal;
}
