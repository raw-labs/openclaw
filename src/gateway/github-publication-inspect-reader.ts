import { resolveConfiguredGitHubHost } from "../../extensions/github-repositories/host-api.js";
import { readRuntimeConfig } from "../config/runtime-snapshot.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
import type { GitHubPublicationRequesterPolicyV2 } from "./github-publication-requester.js";

/** Linked identity only. The caller retains current session, role and connection authority. */
export function captureOwnGitHubPullRequestReader(profileId: string, getHost: () => string) {
  const host = getHost();
  const profile = captureResidentUserProfileAccess(profileId);
  const accountIds = () => {
    const facts = profile.readCurrentFacts();
    // Enterprise identity comes from the catalog's proof-validated binding; a principal-shaped alias alone never qualifies.
    return host === "github.com"
      ? [...(facts.githubAccountIds ?? [])]
      : (facts.enterpriseGitHubAccounts ?? []).flatMap((account) =>
          account.host === host ? [account.accountId] : [],
        );
  };
  const admittedIds = accountIds();
  if (!admittedIds.length) {
    throw new Error(
      "Link a verified GitHub account on the configured host before inspecting your PR.",
    );
  }
  return {
    host,
    accountIds: admittedIds,
    identity: JSON.stringify([profileId, host, admittedIds.toSorted((a, b) => a - b)]),
    assertCurrent: () => {
      const currentIds = accountIds();
      if (getHost() !== host || !admittedIds.every((id) => currentIds.includes(id))) {
        throw new Error(
          "Your linked GitHub identity changed; retry inspection with your current account.",
        );
      }
    },
  };
}

/** Native requester admission selects this one linked-account reader before vendor code runs. */
export function prepareOwnGitHubPullRequestReader(requester: GitHubPublicationRequesterPolicyV2) {
  requester.assertCurrent();
  const actor = requester.snapshot.actor;
  if (actor.kind !== "operator") {
    throw new Error("Inspecting your PR requires your verified linked GitHub account.");
  }
  const reader = captureOwnGitHubPullRequestReader(actor.profileId, () =>
    resolveConfiguredGitHubHost(readRuntimeConfig()),
  );
  return {
    ...reader,
    assertCurrent() {
      requester.assertCurrent();
      reader.assertCurrent();
    },
  };
}
