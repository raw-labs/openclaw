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
  publication?: Partial<NonNullable<RepositoryServices["publication"]>>,
) {
  context.resolveGatewayContext ??= () => context;
  const stop = installRepositoryServices(
    getGatewayServiceLifetime(context),
    { oauth, ...(publication ? { publication: publicationFixtureApi(publication) } : {}) },
    new AbortController().signal,
  );
  onTestFinished(stop);
  return stop;
}
/** Authorization fixtures supply their native operation under the real service lookup. */
function publicationFixtureApi(
  publication: Partial<NonNullable<RepositoryServices["publication"]>>,
): NonNullable<RepositoryServices["publication"]> {
  const unavailable = (): never => {
    throw new Error("Unexpected publication operation in authorization fixture");
  };
  return {
    inspectPullRequest: (...args) =>
      publication.inspectPullRequest ? publication.inspectPullRequest(...args) : unavailable(),
    preparePullRequest: (...args) =>
      publication.preparePullRequest ? publication.preparePullRequest(...args) : unavailable(),
    refreshBase: (...args) =>
      publication.refreshBase ? publication.refreshBase(...args) : unavailable(),
    requestForSessionV2: (...args) =>
      publication.requestForSessionV2 ? publication.requestForSessionV2(...args) : unavailable(),
    requestPersonalForSessionV2: (...args) =>
      publication.requestPersonalForSessionV2
        ? publication.requestPersonalForSessionV2(...args)
        : unavailable(),
    confirmPersonalV2: (...args) =>
      publication.confirmPersonalV2 ? publication.confirmPersonalV2(...args) : unavailable(),
    preparePersonalStatus: (...args) =>
      publication.preparePersonalStatus
        ? publication.preparePersonalStatus(...args)
        : unavailable(),
    personalStatusAsync: (...args) =>
      publication.personalStatusAsync ? publication.personalStatusAsync(...args) : unavailable(),
    personalPending: (...args) =>
      publication.personalPending ? publication.personalPending(...args) : unavailable(),
    sharedStatus: (...args) =>
      publication.sharedStatus ? publication.sharedStatus(...args) : unavailable(),
    latestShared: (...args) =>
      publication.latestShared ? publication.latestShared(...args) : unavailable(),
    latestPublishedShared: (...args) =>
      publication.latestPublishedShared
        ? publication.latestPublishedShared(...args)
        : unavailable(),
  };
}
export async function installPublicationRpcFixture(
  context: GatewayRequestContext,
  publication: Partial<NonNullable<RepositoryServices["publication"]>>,
) {
  const { createGitHubOAuthLifecycle } =
    await import("../../extensions/github-repositories/oauth-lifecycle-runtime-api.js");
  const { createTestGatewayScheduler } = await import("../test-utils/gateway-scheduler-clock.js");
  const scheduler = createTestGatewayScheduler();
  const oauth = createGitHubOAuthLifecycle({
    scheduler,
    getConfig: context.getRuntimeConfig,
    warn: () => {},
  });
  const stop = installGitHubAccountFixture(context, oauth, publication);
  onTestFinished(async () => {
    stop();
    await oauth.stop();
    await scheduler.stop();
  });
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
  options: { resetRuntimeOnFinish?: boolean } = {},
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
  onTestFinished(async () => {
    try {
      await services?.stop({ strict: true });
    } finally {
      if (options.resetRuntimeOnFinish !== false) {
        resetPluginRuntimeStateForTest();
      }
    }
  });
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
  const services = await withPluginRuntimeGatewayContextResolver(
    context.resolveGatewayContext,
    () =>
      startPluginServices({
        scheduler,
        registry: fixture.registry.registry,
        config: context.getRuntimeConfig(),
      }),
  );
  return services;
}
