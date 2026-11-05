import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolvePluginConfigContractsById } from "../plugins/config-contracts.js";
import { normalizeAgentIdStrict } from "../routing/session-key.js";
import { applyUnsetPathsForWrite } from "./config-path-mutation.js";
import { getConfigValueAtPath } from "./config-paths.js";
import { resolveConfigWidePluginManifestRegistry } from "./io.plugin-metadata.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Agent deletion owns config cleanup even while the declaring plugin is disabled. */
export function prunePluginAgentConfigMaps(
  config: OpenClawConfig,
  agentId: string,
  sourceConfig: OpenClawConfig,
): OpenClawConfig {
  const pluginIds = Object.keys(config.plugins?.entries ?? {});
  if (pluginIds.length === 0) {
    return config;
  }
  // The deleted workspace can own the contract, so discover it from the original roster.
  const manifestRegistry = resolveConfigWidePluginManifestRegistry({
    config: sourceConfig,
    pluginIds,
  });
  const contracts = resolvePluginConfigContractsById({
    config: sourceConfig,
    pluginIds,
    manifestRegistry,
  });
  const unsetPaths: string[][] = [];
  for (const [pluginId, metadata] of contracts) {
    const pluginConfig = config.plugins?.entries?.[pluginId]?.config;
    if (!pluginConfig) {
      continue;
    }
    for (const relativePath of metadata.configContracts.agentConfigMaps ?? []) {
      const path = relativePath.split(".");
      const map = getConfigValueAtPath(pluginConfig, path);
      if (!isRecord(map)) {
        continue;
      }
      for (const key of Object.keys(map)) {
        const normalized = normalizeAgentIdStrict(key);
        if (normalized.ok && normalized.value === agentId) {
          unsetPaths.push(["plugins", "entries", pluginId, "config", ...path, key]);
        }
      }
    }
  }
  return applyUnsetPathsForWrite(config, unsetPaths);
}
