import { onTestFinished } from "vitest";
import { githubExecutionEnvironment } from "../../extensions/github-repositories/execution-environment-api.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../plugin-sdk/test-helpers/contracts-testkit.js";
import { isBundledPluginEnabled } from "../plugins/config-state.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";

/** Exercise the real registrar/instance binding without starting account or network services. */
export function createGitHubExecutionFixture(config: OpenClawConfig) {
  const fixture = createPluginRegistryFixture(config);
  const record = createPluginRecord({ id: "github-repositories", origin: "bundled" });
  if (isBundledPluginEnabled(config, record.id)) {
    registerTestPlugin({
      ...fixture,
      record,
      register(api) {
        api.registerExecutionEnvironment(githubExecutionEnvironment);
      },
    });
    onTestFinished(async () => {
      await getPluginInstance(record)?.dispose();
    });
  }
  return {
    registry: fixture.registry.registry,
    close: () => getPluginInstance(record)?.dispose(),
    run<T>(run: () => T): T {
      return withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: fixture.registry.registry, isWebchatConnect: () => false },
        run,
      );
    },
  };
}

/** Use the ordinary CLI secret-preparation owner, including dormant metadata exclusions. */
export async function activateExecutionSecretSnapshot(
  config: OpenClawConfig,
  stateDir: string,
  assignmentConfig: OpenClawConfig = config,
) {
  const {
    activateSecretsRuntimeSnapshot,
    clearSecretsRuntimeSnapshot,
    prepareSecretsRuntimeSnapshot,
  } = await import("../secrets/runtime.js");
  const snapshot = await prepareSecretsRuntimeSnapshot({
    config,
    assignmentConfig,
    env: { OPENCLAW_STATE_DIR: stateDir, HOME: stateDir },
    includeConfigRefs: false,
    includeAuthStoreRefs: false,
    agentDirs: [],
    loadablePluginOrigins: new Map([["github-repositories", "bundled"]]),
    pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "github-repositories",
          origin: "bundled",
        },
      ],
    }),
  });
  activateSecretsRuntimeSnapshot(snapshot);
  onTestFinished(clearSecretsRuntimeSnapshot);
  return snapshot;
}
