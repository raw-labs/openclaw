import { onTestFinished, vi } from "vitest";
import {
  installRepositoryServices,
  type RepositoryServices,
} from "../../extensions/github-repositories/account-runtime-api.js";
import repositoryPlugin from "../../extensions/github-repositories/index.js";
import repositoryManifest from "../../extensions/github-repositories/openclaw.plugin.json" with { type: "json" };
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { setActivePluginRegistry, resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { getGatewayServiceLifetime } from "../plugins/runtime/gateway-service-owner.js";
import { startPluginServices } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createRepositorySessionReadHost } from "./repository-session-read-host.js";
import { createRepositorySources } from "./repository-sources.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

/** Synthetic HTTP transport still uses the real Gateway-owned account service lookup. */
export function installGitHubAccountFixture(
  context: GatewayRequestContext,
  oauth: RepositoryServices["oauth"],
) {
  context.resolveGatewayContext ??= () => context;
  const stop = installRepositoryServices(
    getGatewayServiceLifetime(context),
    { oauth },
    new AbortController().signal,
  );
  onTestFinished(stop);
  return stop;
}
export function installGitHubAccountRpcFixture(config: OpenClawConfig) {
  const fixture = createPluginRegistryFixture(config);
  registerTestPlugin({
    ...fixture,
    record: createPluginRecord({ id: repositoryManifest.id, name: repositoryManifest.name }),
    register: repositoryPlugin.register,
  });
  setActivePluginRegistry(fixture.registry.registry);
  onTestFinished(resetPluginRuntimeStateForTest);
}

export async function callGitHubAccountFixtureRpc(
  context: GatewayRequestContext,
  client: GatewayClient,
  method: string,
  params: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: `rpc-${method}`, method, params },
    client,
    context,
    respond,
    isWebchatConnect: () => false,
  });
  return respond;
}

/** Start the registered service for request tests; native admission remains the real owner. */
export async function startTestRepositorySessionPresentation(
  context: GatewayRequestContext,
  scheduler: GatewayScheduler,
  client?: GatewayClient,
) {
  const fixture = createPluginRegistryFixture(context.getRuntimeConfig());
  registerTestPlugin({
    ...fixture,
    record: createPluginRecord({
      id: repositoryManifest.id,
      name: repositoryManifest.name,
      repositorySources: repositoryManifest.repositorySources,
    }),
    register: repositoryPlugin.register,
  });
  setActivePluginRegistry(fixture.registry.registry);
  onTestFinished(resetPluginRuntimeStateForTest);
  context.resolveGatewayContext ??= () => context;
  context.repositorySources ??= createRepositorySources(scheduler.signal);
  context.repositorySessions ??= createRepositorySessionReadHost({
    signal: scheduler.signal,
    getRuntimeConfig: context.getRuntimeConfig,
    getSessionRowProjection: () => getSessionRowProjection(context),
    getClient: (connId) => (client?.connId === connId ? client : undefined),
    resolveGatewayContext: context.resolveGatewayContext,
    broadcastToConnIds: vi.fn(),
  });
  return await withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, () =>
    startPluginServices({
      scheduler,
      registry: fixture.registry.registry,
      config: context.getRuntimeConfig(),
    }),
  );
}
