import { expect, it } from "vitest";
import { readRepositoryServices } from "../../extensions/github-repositories/account-runtime-api.js";
import repositoryPlugin from "../../extensions/github-repositories/index.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { getPluginRegistryRuntime } from "../plugins/registry-runtime-binding.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-context-binding.js";
import { startPluginServices } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";

it("starts account RPCs once and replaces their service on stop and restart", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(config);
    const context = createGatewayRequestContext(makeContextParams());
    context.getRuntimeConfig = () => config;
    context.resolveGatewayContext = () => context;
    const fixture = createPluginRegistryFixture(config);
    // Service callbacks use the actual Gateway resolver binding, not caller-owned request context.
    bindGatewayContextResolver(
      getPluginRegistryRuntime(fixture.registry.registry)!,
      context.resolveGatewayContext,
    );
    const record = createPluginRecord({ id: "github-repositories", origin: "bundled" });
    registerTestPlugin({ ...fixture, record, register: repositoryPlugin.register });
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
    const scheduler = createTestGatewayScheduler();
    let services = await startPluginServices({
      registry: fixture.registry.registry,
      config,
      scheduler,
    });
    try {
      const first = readRepositoryServices(context);
      expect(first?.oauth).toBeDefined();
      expect(fixture.registry.registry.services).toHaveLength(1);
      expect(context).not.toHaveProperty("githubOAuthService");
      await services.stop({ strict: true });
      expect(readRepositoryServices(context)).toBeUndefined();
      await expect(
        first!.oauth.startAuthorization({ agentId: "main", scope: "system" }),
      ).rejects.toThrow();
      services = await startPluginServices({
        registry: fixture.registry.registry,
        config,
        scheduler,
      });
      expect(readRepositoryServices(context)?.oauth).toBeDefined();
      expect(readRepositoryServices(context)?.oauth).not.toBe(first?.oauth);
    } finally {
      await services.stop({ strict: true });
      await scheduler.stop();
      clearRuntimeConfigSnapshot();
    }
  });
});
