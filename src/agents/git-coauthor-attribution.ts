import {
  prepareGitHubCoauthorAttribution,
  type GitCoauthorAttribution,
} from "../../extensions/github-repositories/git-attribution-api.js";
import {
  MAX_SESSION_PARTICIPANTS,
  isMainGitContributorScope,
  inheritSessionGitContributorProfileIds,
} from "../config/sessions/session-entry-provenance.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  prepareUserProfileGitHubAttribution,
  resolveUserProfileGitHubAttribution,
} from "../state/user-profile-github-identity.js";

type GitCoauthorAttributionParams = {
  agentId: string;
  config: OpenClawConfig;
  excludeAccountId?: number;
  /** Host-verified requester; main is a routing hub, not a task contributor set. */
  requesterProfileId?: string;
  host?: string;
  env?: NodeJS.ProcessEnv;
  sessionKey?: string;
  sessionId?: string;
  storePath?: string;
};

type PreparedGitCoauthorAttribution = {
  attribution: GitCoauthorAttribution | undefined;
  isCurrent: () => boolean;
};

export async function resolveGitCoauthorAttribution(
  params: GitCoauthorAttributionParams,
): Promise<GitCoauthorAttribution | undefined> {
  return (await resolveAttribution(params, false)).attribution;
}

export async function prepareGitCoauthorAttribution(
  params: GitCoauthorAttributionParams,
): Promise<PreparedGitCoauthorAttribution> {
  return await resolveAttribution(params, true);
}

async function resolveAttribution(
  params: GitCoauthorAttributionParams,
  retainAuthority: boolean,
): Promise<PreparedGitCoauthorAttribution> {
  const empty = { attribution: undefined, isCurrent: () => true };
  if (!params.sessionKey || isIncognitoSessionKey(params.sessionKey)) {
    return empty;
  }
  const storePath = resolveSessionStorePathForScope(
    {
      agentId: params.agentId,
      env: params.env,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    params.config,
  );
  const read = await readSessionEntriesFromStoreInWorker({
    agentId: params.agentId,
    env: params.env,
    sessionKeys: [params.sessionKey],
    storePath,
    includeParticipantRecords: true,
    snapshotFields: [],
  });
  const entry = read.entries.find(({ sessionKey }) => sessionKey === params.sessionKey)?.entry;
  if (!entry || entry.incognito || (params.sessionId && entry.sessionId !== params.sessionId)) {
    return empty;
  }
  const records = read.participantRecords?.[params.sessionKey] ?? [];
  const profileRecords = new Map(
    records.flatMap((record) =>
      record.identity.type === "profile" ? [[record.identity.id, record] as const] : [],
    ),
  );
  const inheritedProfileIds = entry.inheritedGitContributorProfileIds ?? [];
  const source = {
    ...params,
    sessionKey: params.sessionKey,
    requesterProfileId: params.requesterProfileId,
  };
  const profileIds = isMainGitContributorScope(source)
    ? (inheritSessionGitContributorProfileIds(entry, source) ?? [])
    : [...new Set([...profileRecords.keys(), ...inheritedProfileIds])];
  if (profileIds.length === 0) {
    return empty;
  }
  return await prepareGitHubCoauthorAttribution({
    agentId: params.agentId,
    config: params.config,
    env: params.env,
    host: params.host,
    excludeAccountId: params.excludeAccountId,
    maximumContributors: MAX_SESSION_PARTICIPANTS,
    contributors: profileIds.map((profileId) => {
      const record = profileRecords.get(profileId);
      return {
        profileId,
        ...(record
          ? {
              contribution: {
                count: record.contributionCount,
                firstPromptedAt: record.firstPromptedAt,
              },
            }
          : {}),
        ...(!record ? { inheritedOrder: inheritedProfileIds.indexOf(profileId) } : {}),
      };
    }),
    readIdentities: async (host) =>
      retainAuthority
        ? await prepareUserProfileGitHubAttribution(profileIds, { env: params.env, host })
        : {
            identities: await resolveUserProfileGitHubAttribution(profileIds, {
              env: params.env,
              host,
            }),
            isCurrent: () => true,
          },
  });
}
