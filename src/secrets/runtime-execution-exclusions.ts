/** Names-only execution exclusions share the existing config secret owners. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { collectCoreExecutionEnvironmentExclusions } from "./runtime-config-collectors-core.js";
import { collectPluginConfigAssignments } from "./runtime-config-collectors-plugins.js";
import { createResolverContext } from "./runtime-shared.js";

/** Prepare once with the run's config; never resolve credentials or execute plugin code. */
export function prepareExecutionEnvironmentExclusions(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}) {
  const context = createResolverContext({
    sourceConfig: params.config,
    env: params.env ?? process.env,
    ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
  });
  const input = { config: params.config, defaults: params.config.secrets?.defaults, context };
  collectCoreExecutionEnvironmentExclusions(input);
  collectPluginConfigAssignments({
    ...input,
    loadablePluginOrigins: params.loadablePluginOrigins,
    mode: "execution-exclusions",
  });
  return context.executionEnvironmentExclusions;
}
