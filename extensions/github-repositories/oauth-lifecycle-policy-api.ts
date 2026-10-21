import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { readGitHubConfig, readGitHubAgentIdentity } from "./config-api.js";
import type {
  GitHubOAuthLifecycleHostV1,
  GitHubDeviceAuthorizationRecord,
  GitHubOAuthRecord,
  GitHubIdentityScope,
  GitHubToolIdentityConfig,
  ConfiguredOAuthIdentity,
  GitHubOAuthInventory,
} from "./oauth-lifecycle-contract.js";
export const REFRESH_SKEW_MS = 10 * 60_000;
export const MAINTENANCE_INTERVAL_MS = 60_000;
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 31_000;

export function createGitHubOAuthLifecyclePolicy(host: GitHubOAuthLifecycleHostV1) {
  const {
    matchesAgentLifecycleBindingAsync,
    matchesAgentLifecycleBinding,
    withAgentRosterFactsBatch,
    listAgentIds,
  } = host.authority;
  const { inspectGitHubOAuthRecord } = host.records;
  const { resolveConfiguredGitHubToolIdentity } = host.profiles;
  const { createReader: createGitHubOAuthInventoryReader } = host.inventory;

  /** Device authorization snapshots must never persist an App signing key. */
  function captureGitHubOAuthAuthorizationIdentity(
    config: OpenClawConfig,
    location: { scope: GitHubIdentityScope; agentId: string },
  ) {
    const selected = resolveConfiguredGitHubToolIdentity({ config, ...location });
    if (selected?.kind === "app-installation") {
      throw new Error(
        "Remove the selected GitHub App identity before connecting an OAuth identity.",
      );
    }
    return structuredClone(selected ?? null);
  }

  function identityStillSelected(
    config: OpenClawConfig,
    location: { scope: GitHubIdentityScope; agentId: string },
    expected: GitHubToolIdentityConfig | null,
  ): boolean {
    const current = resolveConfiguredGitHubToolIdentity({ config, ...location });
    return isDeepStrictEqual(current ?? null, expected);
  }

  function authorizationStillOwned(
    config: OpenClawConfig,
    record: GitHubDeviceAuthorizationRecord,
  ): boolean {
    return (
      identityStillSelected(config, record, record.expectedIdentity) &&
      (record.scope === "system" ||
        (record.agentLifecycleBinding !== undefined &&
          matchesAgentLifecycleBinding(config, record.agentLifecycleBinding)))
    );
  }

  async function authorizationStillOwnedAsync(
    getConfig: () => OpenClawConfig,
    record: GitHubDeviceAuthorizationRecord,
  ): Promise<boolean> {
    if (
      record.scope !== "system" &&
      (!record.agentLifecycleBinding ||
        !(await matchesAgentLifecycleBindingAsync(getConfig, record.agentLifecycleBinding)))
    ) {
      return false;
    }
    return identityStillSelected(getConfig(), record, record.expectedIdentity);
  }

  function configuredOAuthIdentities(config: OpenClawConfig): ConfiguredOAuthIdentity[] {
    return withAgentRosterFactsBatch(config, () => {
      const identities: ConfiguredOAuthIdentity[] = [];
      const system = readGitHubConfig(config).system;
      if (system?.kind === "oauth") {
        identities.push({
          scope: "system",
          agentId: "system",
          identity: { ...system, kind: "oauth" },
        });
      }
      for (const agentId of listAgentIds(config).toSorted()) {
        const identity = readGitHubAgentIdentity(config, agentId);
        if (identity?.kind === "oauth") {
          identities.push({ scope: "agent", agentId, identity: { ...identity, kind: "oauth" } });
        }
      }
      return identities;
    });
  }

  function nextGitHubOAuthMaintenanceAtMs(inventory: GitHubOAuthInventory, now: number): number {
    const retryAtMs = now + MAINTENANCE_INTERVAL_MS;
    let next = Number.POSITIVE_INFINITY;
    for (const { record } of inventory.deviceRecords) {
      if (record) {
        next = Math.min(next, record.expiresAtMs > now ? record.expiresAtMs : retryAtMs);
      }
    }
    for (const { record } of inventory.oauthRecords) {
      if (!record) {
        continue;
      }
      if (record.pendingInitial || record.pendingRefresh || record.refreshFailure === "failed") {
        next = Math.min(next, retryAtMs);
      } else if (record.refreshFailure !== "expired" && record.refreshExpiresAtMs > now) {
        next = Math.min(next, Math.max(retryAtMs, record.accessExpiresAtMs - REFRESH_SKEW_MS));
      }
    }
    return next;
  }

  async function assertInitialOAuthRecordCurrent(
    getConfig: () => OpenClawConfig,
    expected: GitHubOAuthRecord,
    runtimeConfig: OpenClawConfig,
    runtimeConfigValue: OpenClawConfig,
  ): Promise<void> {
    const current = await inspectGitHubOAuthRecord(expected.profileId);
    if (
      getConfig() !== runtimeConfig ||
      !isDeepStrictEqual(runtimeConfig, runtimeConfigValue) ||
      current.state !== "valid" ||
      !isDeepStrictEqual(current.record, expected)
    ) {
      throw new Error("GitHub OAuth initial reconciliation was superseded.");
    }
  }

  async function pendingInitialOAuthIdentitySelected(
    config: OpenClawConfig,
    record: GitHubOAuthRecord,
  ): Promise<boolean> {
    const identity = resolveConfiguredGitHubToolIdentity({ config, ...record });
    const binding = record.pendingInitial?.agentLifecycleBinding;
    const agentBindingMatches =
      record.scope === "system" ||
      (binding !== undefined && (await matchesAgentLifecycleBindingAsync(() => config, binding)));
    return (
      agentBindingMatches && identity?.profileId === record.profileId && identity.kind === "oauth"
    );
  }

  return {
    createGitHubOAuthInventoryReader,
    captureGitHubOAuthAuthorizationIdentity,
    identityStillSelected,
    authorizationStillOwned,
    authorizationStillOwnedAsync,
    configuredOAuthIdentities,
    nextGitHubOAuthMaintenanceAtMs,
    assertInitialOAuthRecordCurrent,
    pendingInitialOAuthIdentitySelected,
  };
}
