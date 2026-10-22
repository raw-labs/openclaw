import { prepareGitCoauthorAttribution } from "../agents/git-coauthor-attribution.js";
import { resolveControlUiPublicSessionUrl } from "../config/control-ui-link-base.js";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GitHubPublicationCreditChangedError } from "./github-publication-failure.js";
import type { RepositoryPublicationContentFactsV1 } from "./repository-publication-content-contract.js";

/** Reuse the accepted owner's retained read; formatting never selects session storage. */
export async function prepareRepositoryPublicationContentFacts(params: {
  session: { agentId: string; sessionKey: string; sessionId: string };
  storePath: string;
  config: OpenClawConfig;
  accountId: number;
  host: string;
  readCurrentEntry: () => InternalSessionEntry | undefined;
  assertCurrent: () => void;
}): Promise<RepositoryPublicationContentFactsV1> {
  const initialEntry = params.readCurrentEntry();
  const initialShare = resolveSessionPublicShare(initialEntry);
  const sessionUrl = resolveControlUiPublicSessionUrl(params.config, {
    ...params.session,
    entry: initialEntry,
  });
  const prepared = await prepareGitCoauthorAttribution({
    ...params.session,
    config: params.config,
    excludeAccountId: params.accountId,
    host: params.host,
    storePath: params.storePath,
  });
  return {
    credit: {
      trailers: prepared.attribution?.trailers ?? [],
      logins: prepared.attribution?.logins ?? [],
    },
    assertCurrent() {
      params.assertCurrent();
      if (!prepared.isCurrent()) {
        throw new GitHubPublicationCreditChangedError();
      }
    },
    currentSessionUrl() {
      const currentShare = resolveSessionPublicShare(params.readCurrentEntry());
      return sessionUrl &&
        currentShare?.id === initialShare?.id &&
        currentShare?.sessionId === initialShare?.sessionId
        ? sessionUrl
        : undefined;
    },
  };
}
