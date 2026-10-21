/** Clone prepared secrets snapshots without sharing mutable config or refresh context. */
import { cloneConfigWithResolutionFacts } from "../config/resolution-facts.js";
import type {
  PreparedSecretsRuntimeSnapshot,
  SecretsRuntimeRefreshContext,
} from "./runtime-state.js";

/**
 * Clones refresh context while preserving callback identity and isolating mutable maps/config.
 */
export function cloneSecretsRuntimeRefreshContext(
  context: SecretsRuntimeRefreshContext,
): SecretsRuntimeRefreshContext {
  return {
    env: { ...context.env },
    explicitAgentDirs: context.explicitAgentDirs ? [...context.explicitAgentDirs] : null,
    includeConfigRefs: context.includeConfigRefs ?? true,
    includeAuthStoreRefs: context.includeAuthStoreRefs,
    loadablePluginOrigins: new Map(context.loadablePluginOrigins),
    ...(context.manifestRegistry ? { manifestRegistry: context.manifestRegistry } : {}),
    ...(context.loadAuthStore ? { loadAuthStore: context.loadAuthStore } : {}),
  };
}

export function cloneSecretsRuntimeSnapshot(
  snapshot: PreparedSecretsRuntimeSnapshot,
  authStores: PreparedSecretsRuntimeSnapshot["authStores"],
): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: cloneConfigWithResolutionFacts(snapshot.sourceConfig),
    config: cloneConfigWithResolutionFacts(snapshot.config),
    authStores,
    authStoreCredentialsRevision: snapshot.authStoreCredentialsRevision,
    authStoreSnapshotsRevision: snapshot.authStoreSnapshotsRevision,
    warnings: snapshot.warnings.map((warning) => ({ ...warning })),
    degradedOwners: structuredClone(snapshot.degradedOwners ?? []),
    secretOwners: structuredClone(snapshot.secretOwners ?? []),
    webTools: structuredClone(snapshot.webTools),
    ...(snapshot.executionEnvironmentExclusions
      ? {
          executionEnvironmentExclusions: Object.freeze({
            credentialScrubEnv: Object.freeze({
              ...snapshot.executionEnvironmentExclusions.credentialScrubEnv,
            }),
            excludedStoreNames: Object.freeze([
              ...snapshot.executionEnvironmentExclusions.excludedStoreNames,
            ]),
          }),
        }
      : {}),
  };
}
