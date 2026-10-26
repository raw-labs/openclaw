// Combines mutable runtime handles with startup-resolved services for request contexts.
import type { PluginServicesHandle } from "../plugins/services.js";
import type { HooksConfigResolved } from "./hooks.js";
import type { RepositorySessionReadHost } from "./repository-session-read-host.js";
import type { GatewayCronState } from "./server-cron.js";
import {
  createGatewayServerMutableState,
  type GatewayServerMutableState,
} from "./server-runtime-handles.js";
import type { HookClientIpConfig } from "./server/hooks-request-handler.js";
import type { createSessionViewerPresenceDeclarations } from "./session-viewer-presence.js";

/** Mutable gateway server state shared across request contexts. */
export type GatewayServerLiveState = GatewayServerMutableState & {
  hooksConfig: HooksConfigResolved | null;
  hookClientIpConfig: HookClientIpConfig;
  cronState: GatewayCronState;
  repositorySessions?: RepositorySessionReadHost;
  sessionViewerPresence?: ReturnType<typeof createSessionViewerPresenceDeclarations>;
  pluginServices: PluginServicesHandle | null;
  gatewayMethods: string[];
};

export function createGatewayServerLiveState(params: {
  hooksConfig: HooksConfigResolved | null;
  hookClientIpConfig: HookClientIpConfig;
  cronState: GatewayCronState;
  gatewayMethods: string[];
}): GatewayServerLiveState {
  return {
    ...createGatewayServerMutableState(),
    hooksConfig: params.hooksConfig,
    hookClientIpConfig: params.hookClientIpConfig,
    cronState: params.cronState,
    repositorySessions: undefined,
    sessionViewerPresence: undefined,
    pluginServices: null,
    gatewayMethods: params.gatewayMethods,
  };
}
