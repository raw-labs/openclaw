import { expect, it } from "vitest";
import { readRepositoryServices } from "../../extensions/github-repositories/account-runtime-api.js";
import repositoryPlugin from "../../extensions/github-repositories/index.js";
import repositoryManifest from "../../extensions/github-repositories/openclaw.plugin.json" with { type: "json" };
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { getPluginRegistryRuntime } from "../plugins/registry-runtime-binding.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-context-binding.js";
import { startPluginServices } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRepositorySessionReadHost } from "./repository-session-read-host.js";
import { createRepositorySources } from "./repository-sources.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";

it("starts account RPCs once and replaces their service on stop and restart", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(config);
    const scheduler = createTestGatewayScheduler();
    const contextParams = makeContextParams();
    const context = createGatewayRequestContext(contextParams);
    context.getRuntimeConfig = () => config;
    context.resolveGatewayContext = () => context;
    contextParams.runtime.runtimeState.repositorySessions = createRepositorySessionReadHost({
      signal: scheduler.signal,
      getRuntimeConfig: context.getRuntimeConfig,
      getSessionRowProjection: () => undefined,
      getClient: () => undefined,
      resolveGatewayContext: context.resolveGatewayContext,
      broadcastToConnIds: () => {},
    });
    const fixture = createPluginRegistryFixture(config);
    // Service callbacks use the actual Gateway resolver binding, not caller-owned request context.
    bindGatewayContextResolver(
      getPluginRegistryRuntime(fixture.registry.registry)!,
      context.resolveGatewayContext,
    );
    const record = createPluginRecord({
      id: "github-repositories",
      origin: "bundled",
      contracts: repositoryManifest.contracts,
      repositorySources: repositoryManifest.repositorySources,
    });
    registerTestPlugin({ ...fixture, record, register: repositoryPlugin.register });
    context.repositorySources = createRepositorySources(
      scheduler.signal,
      fixture.registry.registry,
    );
    const instance = getPluginInstance(record)!;
    expect(
      fixture.registry.registry.gatewayMethodDescriptors.find(
        (row) => row.name === "users.github.authorize.start",
      ),
    ).toMatchObject({
      scope: "operator.read",
      startup: "unavailable-until-sidecars",
      controlPlaneWrite: true,
      since: "2026.8",
    });
    let services = await startPluginServices({
      registry: fixture.registry.registry,
      config,
      scheduler,
    });
    try {
      const firstSource = context.repositorySources.resolve("https://github.com/acme/project.git");
      firstSource.assertCurrent();
      const first = readRepositoryServices(context);
      expect(first?.oauth).toBeDefined();
      expect(fixture.registry.registry.services).toHaveLength(1);
      expect(context).not.toHaveProperty("githubOAuthService");
      await services.stop({ strict: true });
      expect(readRepositoryServices(context)).toBeUndefined();
      // Source registration belongs to the plugin instance, not an account service restart.
      firstSource.assertCurrent();
      await expect(
        first!.oauth.startAuthorization({ agentId: "main", scope: "system" }),
      ).rejects.toThrow();
      services = await startPluginServices({
        registry: fixture.registry.registry,
        config,
        scheduler,
      });
      context.repositorySources.resolve("https://github.com/acme/project.git").assertCurrent();
      firstSource.assertCurrent();
      expect(readRepositoryServices(context)?.oauth).toBeDefined();
      expect(readRepositoryServices(context)?.oauth).not.toBe(first?.oauth);
      await services.stop({ strict: true });
      await instance.dispose();
      expect(() => firstSource.assertCurrent()).toThrow();
    } finally {
      await services.stop({ strict: true });
      await instance.dispose();
      await scheduler.stop();
      clearRuntimeConfigSnapshot();
    }
  });
});
