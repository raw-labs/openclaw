import { onTestFinished } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import type { ExecutionEnvironmentProviderV1 } from "./execution-environment-types.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { withPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

export function createExecutionEnvironmentFixture(provider: ExecutionEnvironmentProviderV1) {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "execution-example",
    source: "/synthetic/execution-example.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  const instance = getPluginInstance(record)!;
  onTestFinished(async () => {
    await instance.dispose();
  });
  api.registerExecutionEnvironment(provider);
  return {
    instance,
    registry: builder.registry,
    run<T>(operation: () => T) {
      return withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: builder.registry, isWebchatConnect: () => false },
        operation,
      );
    },
  };
}

export async function activateDisabledExecutionExclusions(config: OpenClawConfig) {
  const sourceConfig: OpenClawConfig = {
    ...config,
    plugins: {
      entries: {
        "disabled-execution": {
          enabled: false,
          config: {
            inherited: { source: "env", provider: "default", id: "EXECUTION_EXCLUDED_VALUE" },
            stored: { source: "store", provider: "default", id: "EXECUTION_EXCLUDED_STORED" },
          },
        },
      },
    },
  };
  const snapshot = await prepareSecretsRuntimeSnapshot({
    config: sourceConfig,
    includeConfigRefs: false,
    includeAuthStoreRefs: false,
    loadablePluginOrigins: new Map([["disabled-execution", "bundled"]]),
    pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "disabled-execution",
          configContracts: {
            secretInputs: {
              paths: ["inherited", "stored"].map((path) => ({
                path,
                executionEnvironment: "exclude",
              })),
            },
          },
        },
      ],
    }),
  });
  activateSecretsRuntimeSnapshot(snapshot);
  onTestFinished(() => clearSecretsRuntimeSnapshot());
  return sourceConfig;
}
