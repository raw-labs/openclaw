import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { TaskPublicationRead } from "../state/github-publication-task-reads.worker.js";
import { guardRepositorySessionRead } from "./repository-session-read-guard.js";
import type { createRepositoryTaskPublicationReader } from "./repository-session-read-receipts.js";
import type { PreparedRepositorySessionRead } from "./repository-session-read.types.js";
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
