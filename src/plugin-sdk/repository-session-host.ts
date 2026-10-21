/** Gateway lifetime and authenticated personal-caller operations for managed repository accounts. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { getGatewayServiceLifetime } from "../plugins/runtime/gateway-service-owner.js";
export function captureRepositoryServiceHost():
  | {
      identity: AbortSignal;
      getConfig: () => OpenClawConfig;
      assertCurrent: () => void;
    }
  | undefined {
  const resolveGatewayContext = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const context = resolveGatewayContext?.();
  if (!context || !resolveGatewayContext) {
    return undefined;
  }
  const identity = getGatewayServiceLifetime({ resolveGatewayContext });
  if (getGatewayServiceLifetime(context) !== identity) {
    throw new Error("Repository account service has an incompatible Gateway owner.");
  }
  const assertCurrent = () => {
    identity.throwIfAborted();
    if (getGatewayServiceLifetime({ resolveGatewayContext }) !== identity) {
      throw new Error("Repository account service Gateway owner was replaced.");
    }
  };
  return {
    identity,
    getConfig: context.getRuntimeConfig,
    assertCurrent,
  };
}

/** Prepare canonical personal authority without eagerly loading the account/publication graph. */
export async function prepareGatewayPersonalCallerV2(
  ...args: Parameters<
    typeof import("../gateway/server-methods/github-personal-authorization.js").preparePersonalGitHubActionV2
  >
): ReturnType<
  typeof import("../gateway/server-methods/github-personal-authorization.js").preparePersonalGitHubActionV2
> {
  const { preparePersonalGitHubActionV2 } =
    await import("../gateway/server-methods/github-personal-authorization.js");
  return preparePersonalGitHubActionV2(...args);
}
