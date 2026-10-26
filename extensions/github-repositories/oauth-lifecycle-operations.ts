import { isDeepStrictEqual } from "node:util";
import type { ToolsGitHubAuthorizePollResult } from "@openclaw/gateway-protocol";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { GitHubOAuthTokenPair } from "./oauth-api.js";
import type {
  GitHubOAuthLifecycleHostV1,
  GitHubDeviceAuthorizationRecord,
  GitHubOAuthRecord,
} from "./oauth-lifecycle-contract.js";
import type { createGitHubOAuthLifecyclePolicy } from "./oauth-lifecycle-policy-api.js";
type GitHubToolAccount = Parameters<
  GitHubOAuthLifecycleHostV1["records"]["createGitHubOAuthRecord"]
>[0]["account"];

export function createGitHubOAuthDevicePoller(
  host: GitHubOAuthLifecycleHostV1,
  options: {
    getConfig: () => OpenClawConfig;
    signal: AbortSignal;
    queueDeviceCleanup: (requestId: string) => Promise<void>;
    installDeviceTokens: (
      record: GitHubDeviceAuthorizationRecord,
      tokens: GitHubOAuthTokenPair,
    ) => Promise<ToolsGitHubAuthorizePollResult>;
    authorizationStillOwnedAsync: ReturnType<
      typeof createGitHubOAuthLifecyclePolicy
    >["authorizationStillOwnedAsync"];
  },
) {
  const { readGitHubDeviceAuthorizationRecord, writeGitHubDeviceAuthorizationRecord } =
    host.records;
  const { pollGitHubDeviceFlow } = host.transport;
  return async (requestId: string): Promise<ToolsGitHubAuthorizePollResult> => {
    const record = await readGitHubDeviceAuthorizationRecord(requestId);
    const now = Date.now();
    if (!record || record.expiresAtMs <= now) {
      await options.queueDeviceCleanup(requestId);
      return {
        status: "expired",
      };
    }
    if (!(await options.authorizationStillOwnedAsync(options.getConfig, record))) {
      await options.queueDeviceCleanup(requestId);
      return {
        status: "failed",
        reason: "identity_changed",
      };
    }
    const result = await pollGitHubDeviceFlow(record, options.signal);
    const currentRecord = await readGitHubDeviceAuthorizationRecord(requestId);
    if (!currentRecord) {
      return {
        status: "expired",
      };
    }
    if (
      currentRecord.deviceCode !== record.deviceCode ||
      currentRecord.createdAtMs !== record.createdAtMs ||
      !isDeepStrictEqual(currentRecord.expectedIdentity, record.expectedIdentity)
    ) {
      await options.queueDeviceCleanup(requestId);
      return {
        status: "failed",
        reason: "identity_changed",
      };
    }
    if (result.kind === "authorized") {
      return await options.installDeviceTokens(currentRecord, result.tokens);
    }
    if (result.kind === "waiting") {
      await writeGitHubDeviceAuthorizationRecord({
        ...currentRecord,
        pollIntervalMs: result.pollIntervalMs,
        nextPollAtMs: result.nextPollAtMs,
      });
    } else {
      await options.queueDeviceCleanup(requestId);
    }
    return result.result;
  };
}

export function createGitHubOAuthRefreshCommitter(host: GitHubOAuthLifecycleHostV1) {
  const { writeGitHubOAuthRecord } = host.records;
  const {
    resolveManagedGitHubProfileDir,
    refreshManagedGitHubProfile,
    GitHubAccountMismatchError,
  } = host.profiles;
  return async (
    record: GitHubOAuthRecord & {
      pendingRefresh: true;
    },
    accessToken: string,
  ): Promise<void> => {
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: record.agentId,
      scope: record.scope,
      profileId: record.profileId,
    });
    let account: GitHubToolAccount;
    try {
      account = await refreshManagedGitHubProfile({
        profileDir,
        token: accessToken,
        expectedAccountId: record.accountId,
      });
    } catch (error) {
      if (error instanceof GitHubAccountMismatchError) {
        await writeGitHubOAuthRecord({
          ...record,
          pendingRefresh: undefined,
          refreshFailure: "expired",
        });
      }
      return;
    }
    await writeGitHubOAuthRecord({
      ...record,
      login: account.login,
      pendingRefresh: undefined,
      refreshFailure: undefined,
    });
  };
}
