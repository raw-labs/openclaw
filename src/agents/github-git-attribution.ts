import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredGitHubHost } from "./github-host.js";
import { resolveConfiguredGitHubToolIdentity } from "./github-tool-identity.js";

export type GitCoauthorAttribution = { trailers: string[]; logins: string[] };

type VerifiedGitCoauthorIdentity =
  | { accountId: number; login: string }
  | { accountId: number; login: string; host: string; verifiedEmail?: string };

type GitCoauthorContributor = {
  accountId: number;
  email: string;
  contributionCount: number;
  firstPromptedAt: number | null;
  login: string;
  inheritedOrder?: number;
};

/** The host selects participants and reads verified/consented facts; vendor policy only formats them. */
export async function prepareGitHubCoauthorAttribution(params: {
  agentId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  host?: string;
  excludeAccountId?: number;
  maximumContributors: number;
  contributors: readonly {
    profileId: string;
    contribution?: { count: number; firstPromptedAt: number | null };
    inheritedOrder?: number;
  }[];
  readIdentities: (host: string) => Promise<{
    identities: ReadonlyMap<string, VerifiedGitCoauthorIdentity | null>;
    isCurrent: () => boolean;
  }>;
}): Promise<{ attribution: GitCoauthorAttribution | undefined; isCurrent: () => boolean }> {
  const host = params.host ?? resolveConfiguredGitHubHost(params.config);
  const prepared = await params.readIdentities(host);
  const identities = prepared.identities;
  const primaryIdentity =
    resolveConfiguredGitHubToolIdentity({ ...params, scope: "agent" }) ??
    resolveConfiguredGitHubToolIdentity({ ...params, scope: "system" });
  const primaryEmail = primaryIdentity?.gitAuthor?.email?.trim().toLowerCase();
  const contributors = new Map<number, GitCoauthorContributor>();
  for (const record of params.contributors) {
    const identity = identities.get(record.profileId);
    if (!identity) {
      continue;
    }
    const issuer = "host" in identity ? identity.host : "github.com";
    if (issuer !== host || identity.accountId === params.excludeAccountId) {
      continue;
    }
    const email =
      "host" in identity
        ? identity.verifiedEmail
        : `${identity.accountId}+${identity.login}@users.noreply.github.com`;
    if (!email) {
      continue;
    }
    // An explicit publisher replaces the configured primary; the other account may deserve credit.
    if (params.excludeAccountId === undefined && email.toLowerCase() === primaryEmail) {
      continue;
    }
    const contributor = contributors.get(identity.accountId);
    if (contributor) {
      if (record.contribution) {
        contributor.contributionCount += record.contribution.count;
        contributor.firstPromptedAt =
          contributor.firstPromptedAt === null || record.contribution.firstPromptedAt === null
            ? null
            : Math.min(contributor.firstPromptedAt, record.contribution.firstPromptedAt);
      }
      continue;
    }
    contributors.set(identity.accountId, {
      accountId: identity.accountId,
      email,
      contributionCount: record.contribution?.count ?? 0,
      firstPromptedAt: record.contribution?.firstPromptedAt ?? null,
      login: identity.login,
      inheritedOrder: record.inheritedOrder,
    });
  }

  const orderedContributors = [...contributors.values()].toSorted(
    (left, right) =>
      right.contributionCount - left.contributionCount ||
      (left.firstPromptedAt === null
        ? right.firstPromptedAt === null
          ? 0
          : 1
        : right.firstPromptedAt === null
          ? -1
          : left.firstPromptedAt - right.firstPromptedAt) ||
      (left.inheritedOrder ?? Number.MAX_SAFE_INTEGER) -
        (right.inheritedOrder ?? Number.MAX_SAFE_INTEGER) ||
      left.accountId - right.accountId,
  );
  const visibleContributors = orderedContributors.slice(0, params.maximumContributors);
  const logins = visibleContributors.map(({ login }) => login);
  const trailers = visibleContributors.map(
    ({ email, login }) => `Co-authored-by: ${login} <${email}>`,
  );
  return {
    attribution: trailers.length ? { trailers, logins } : undefined,
    isCurrent: prepared.isCurrent,
  };
}
