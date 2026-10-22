import { requestCurrentGitHubOAuthRefresh } from "../../../extensions/github-repositories/account-runtime-api.js";
import { currentGitHubPublicationConfig } from "../../../extensions/github-repositories/publication-availability-api.js";
import {
  GitHubIdentityError,
  prepareGitHubReadIdentity,
} from "../../../extensions/github-repositories/tool-identity-api.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";

/** Checkout requires identity admission; optional publication discovery cannot authorize anonymous Git. */
export async function prepareRepositoryGitHubIdentity(agentId: string, assertCurrent: () => void) {
  const config = currentGitHubPublicationConfig();
  try {
    return await prepareGitHubReadIdentity({
      config,
      sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
      agentId,
      getCurrentConfig: currentGitHubPublicationConfig,
      assertActive: assertCurrent,
      refresh: () => requestCurrentGitHubOAuthRefresh(agentId),
      allowAnonymous: true,
    });
  } catch (error) {
    assertCurrent();
    // Credential storage/subprocess failures need safe, actionable identity guidance.
    throw error instanceof GitHubIdentityError ? error : new GitHubIdentityError("unverified");
  }
}
