import { isDeepStrictEqual } from "node:util";
import type { GitHubIdentityFacts } from "@openclaw/gateway-protocol";
import { assertSecretOwnerAvailable } from "openclaw/plugin-sdk/channel-secret-owner-runtime";
import { formatConcreteConfigPath } from "openclaw/plugin-sdk/config-contracts";
import {
  prepareGitHubAppInstallation,
  readGitHubAppInstallationMetadata,
} from "./app-installation-api.js";
import type { GitHubAppSelection, GitHubCredentialReader } from "./credential-reader-api.js";
import { resolveGitHubHost, resolveGitHubApiBaseUrl } from "./host-runtime-api.js";
import { GitHubIdentityError, type GitHubIdentityPreparation } from "./read-identity-api.js";

export async function prepareAppGitHubIdentity(
  params: GitHubIdentityPreparation & {
    assertCurrent?: () => void;
    allowAppInstallation?: boolean;
    requestedRepository?: string;
    readNativeCredential?: GitHubCredentialReader;
  },
  selection: GitHubAppSelection,
  source: "system-configured" | "agent-override",
  env: NodeJS.ProcessEnv,
  host: string,
  apiBaseUrl: string,
) {
  // Existing publication and background readers do not own App token cleanup.
  if (!params.allowAppInstallation) {
    throw new GitHubIdentityError("unavailable");
  }
  const privateKeyPath = formatConcreteConfigPath([
    "plugins",
    "entries",
    "github-repositories",
    "config",
    ...(source === "agent-override" ? ["agents", params.agentId] : ["system"]),
    "app",
    "privateKey",
  ]);
  const snapshot = structuredClone(selection);
  const assertCurrent = () => {
    params.assertCurrent?.();
    assertSecretOwnerAvailable("capability", privateKeyPath);
    if (
      resolveGitHubHost() !== host ||
      resolveGitHubApiBaseUrl() !== apiBaseUrl ||
      !isDeepStrictEqual(selection, snapshot)
    ) {
      throw new GitHubIdentityError("changed");
    }
  };
  assertCurrent();
  let requestedSelection = selection;
  const requestedRepository = params.requestedRepository?.toLowerCase();
  if (requestedRepository !== undefined) {
    const repository = selection.app.repositories.find(
      (repo) => repo.fullName.toLowerCase() === requestedRepository,
    );
    if (!repository) {
      throw new GitHubIdentityError("unavailable");
    }
    // Retain the complete selection above for currency checks. Only the grant
    // and broker receipt are narrowed to the repository this request reads.
    requestedSelection = { ...selection, app: { ...selection.app, repositories: [repository] } };
  }
  if (process.env.FACTORY_AUTH_MODE === "github") {
    if (!params.readNativeCredential) {
      throw new GitHubIdentityError("unavailable");
    }
    await params.readNativeCredential(env, {
      kind: "repository-admission",
      host,
      selection: requestedSelection,
    });
    assertCurrent();
  }
  const issued = await prepareGitHubAppInstallation({
    selection,
    privateKeyPath,
    repositories: requestedSelection.app.repositories,
    host,
    apiBaseUrl,
    assertCurrent,
  });
  try {
    assertCurrent();
    const prepared = Object.freeze({
      source,
      profileId: selection.profileId,
      host,
      account: issued.account,
      accessExpiresAtMs: issued.expiresAtMs,
      revoke: issued.revoke,
    });
    return { prepared, token: issued.token, readToken: issued.readToken, stale: undefined };
  } catch (error) {
    await issued.revoke().catch(() => {});
    throw error;
  }
}

export function configuredAppGitHubIdentityFacts(
  selection: GitHubAppSelection,
  source: "system-configured" | "agent-override",
): GitHubIdentityFacts {
  const metadata = readGitHubAppInstallationMetadata(
    selection,
    resolveGitHubHost(),
    resolveGitHubApiBaseUrl(),
  );
  return {
    source,
    credentialKind: "app-installation",
    credentialState: metadata ? "available" : "configured_unavailable",
    account: metadata ? { login: metadata.account.login } : null,
    gitAuthor: {
      name: selection.gitAuthor?.name ?? null,
      email: selection.gitAuthor?.email ?? null,
    },
    evidence: metadata ? "github-api" : "none",
    accessExpiresAtMs: metadata?.expiresAtMs ?? null,
    refreshState: "not_applicable",
    oauthScopes: [],
    repositoryGrants: "unknown",
  };
}

export function configuredAppGitHubOptionsIdentity(
  selection: GitHubAppSelection,
  source: "system-configured" | "agent-override",
) {
  const metadata = readGitHubAppInstallationMetadata(
    selection,
    resolveGitHubHost(),
    resolveGitHubApiBaseUrl(),
  );
  if (!metadata) {
    throw new GitHubIdentityError("unavailable");
  }
  return { source, account: metadata.account, stale: undefined };
}
