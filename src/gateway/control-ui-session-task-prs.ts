import { createRetainedCache } from "../infra/retained-cache.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import type { TaskPublicationRead } from "../state/github-publication-task-reads.worker.js";
import { readGitHubPublicationInWorker } from "../state/github-publication-worker.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import { guardRepositorySessionRead } from "./control-ui-session-pr-source.js";
import type { PreparedRepositorySessionRead } from "./repository-session-read.types.js";
import type { RepositoryTaskPublications } from "./repository-session-read.types.js";
import type { EntryRow } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";

/** Traverse the row owner's indexed lineage; neither checkout nor transcript is evidence. */
function selectTaskPublicationSessions(
  projection: SessionRowProjection,
  root: EntryRow,
  allows: (row: EntryRow) => boolean,
): TaskPublicationRead["sessions"] {
  const seen = new Set<string>();
  const pending = [root];
  const sessions: TaskPublicationRead["sessions"] = [];
  for (const row of pending) {
    const identity = JSON.stringify([row.agentId, row.key, row.entry.sessionId]);
    if (
      seen.has(identity) ||
      row.entry.incognito ||
      isIncognitoSessionKey(row.key) ||
      !allows(row)
    ) {
      continue;
    }
    seen.add(identity);
    sessions.push({
      agentId: row.agentId,
      sessionKey: row.key,
      sessionId: row.entry.sessionId,
      lifecycleRevision: row.entry.lifecycleRevision ?? null,
    });
    pending.push(...projection.selectEntries({ parentSessionKey: row.key }));
  }
  return sessions.toSorted(
    (a, b) => a.sessionKey.localeCompare(b.sessionKey) || a.agentId.localeCompare(b.agentId),
  );
}

/** The host alone selects lineage and personal receipt audience from current access. */
export function withRepositoryTaskAudience(
  target: PreparedRepositorySessionRead | undefined,
  projection: SessionRowProjection,
  root: EntryRow,
  getAllows: () => (row: EntryRow) => boolean,
  readReceipts: ReturnType<typeof createRepositoryTaskPublicationReader>,
  ownerProfileId?: string,
): PreparedRepositorySessionRead | undefined {
  if (!target || root.entry.incognito || isIncognitoSessionKey(root.key)) {
    return target;
  }
  const select = () => ({
    sessions: selectTaskPublicationSessions(projection, root, getAllows()),
    ...(ownerProfileId ? { ownerProfileId } : {}),
  });
  const selected = select();
  const audience = JSON.stringify(selected);
  const assertCurrent = () => {
    target.assertCurrent();
    if (JSON.stringify(select()) !== audience) {
      throw new Error("Task publication audience changed");
    }
  };
  return guardRepositorySessionRead(target, {
    assertCurrent,
    identity: JSON.stringify([target.identity, audience]),
    taskAudienceKey: JSON.stringify(ownerProfileId ?? null),
    readTaskPublications: (input, signal) =>
      readReceipts(
        { ...selected, ...(input.branchUrls ? { branchUrls: [...input.branchUrls] } : {}) },
        assertCurrent,
        signal,
      ),
  });
}

/** The existing receipt backend owns schema and audience filtering; no row or database handle escapes. */
const cache = createRetainedCache<Promise<RepositoryTaskPublications>>();
githubPublicationReceipts.subscribeFacts((change) => {
  if (change.kind === "committed" || change.kind === "unknown") {
    cache.clear();
  }
});
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened") {
    cache.clear();
  }
});

export function createRepositoryTaskPublicationReader(signal: AbortSignal) {
  return async (
    input: TaskPublicationRead,
    assertCurrent: () => void,
    readSignal?: AbortSignal,
  ): Promise<RepositoryTaskPublications> => {
    signal.throwIfAborted();
    readSignal?.throwIfAborted();
    assertCurrent();
    const source = captureOpenClawStateReadContext();
    source.admission.assertCurrent();
    const key = JSON.stringify([source.admission.identity.key, input]);
    let pending = cache.get(key, readSignal);
    if (!pending) {
      pending = (async () => {
        const reply = await readGitHubPublicationInWorker({
          type: "githubPublications.taskReceipts",
          input,
        });
        source.admission.assertCurrent();
        const result =
          reply?.type === "githubPublications.taskReceipts"
            ? reply.result
            : { receipts: [], count: 0, branchMatchCount: 0 };
        return {
          receipts: result.receipts.flatMap((row) =>
            row.pull_request_url
              ? [
                  {
                    url: row.pull_request_url,
                    branch: row.branch,
                    ...(row.title ? { title: row.title } : {}),
                    session: {
                      sessionKey: row.session_key,
                      agentId: row.agent_id,
                    },
                  },
                ]
              : [],
          ),
          count: result.count,
          branchMatchCount: result.branchMatchCount,
        };
      })();
      cache.set(key, pending, readSignal);
      const selected = pending;
      void pending.catch(() => cache.delete(key, selected));
    }
    const result = await pending;
    source.admission.assertCurrent();
    signal.throwIfAborted();
    readSignal?.throwIfAborted();
    assertCurrent();
    return result;
  };
}
