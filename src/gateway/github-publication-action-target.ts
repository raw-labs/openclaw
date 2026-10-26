import { parseAgentSessionKey } from "../routing/session-key.js";
import { prepareRepositoryPublicationSession } from "./repository-publication-workspace-authority.js";

type SessionRead = Awaited<ReturnType<typeof prepareRepositoryPublicationSession>>;

/** Keep every selected parent alive; a reparented child cannot redirect a retained action. */
export async function preparePublishingSession(
  params: { sessionKey: string; agentId?: string; publishingSessionKey?: string },
  assertCurrent: () => void,
  resources: DisposableStack,
) {
  const source = resources.use(
    await prepareRepositoryPublicationSession(params.sessionKey, {
      agentId: params.agentId,
      assertCurrent,
    }),
  );
  const selected =
    params.publishingSessionKey && params.publishingSessionKey !== source.loaded.canonicalKey
      ? resources.use(
          await prepareRepositoryPublicationSession(params.publishingSessionKey, { assertCurrent }),
        )
      : source;
  const readers: SessionRead[] = [source, selected];
  const assertSessions = () => {
    assertCurrent();
    for (const reader of readers) {
      if (!reader.readCurrent().entry?.sessionId) {
        throw new Error("The GitHub publication session is unavailable.");
      }
    }
  };
  let key = selected.loaded.canonicalKey;
  let agentId = selected.loaded.agentId;
  const seen = new Set<string>();
  while (key !== source.loaded.canonicalKey || agentId !== source.loaded.agentId) {
    const identity = `${agentId}\0${key}`;
    if (seen.has(identity) || seen.size >= 64) {
      throw new Error("The publishing session is not a child of this conversation.");
    }
    seen.add(identity);
    const lineage = resources.use(
      await prepareRepositoryPublicationSession(key, {
        agentId: parseAgentSessionKey(key) ? undefined : agentId,
        assertCurrent,
        fields: ["sessionId", "lifecycleRevision", "parentSessionKey", "spawnedBy"],
      }),
    );
    readers.push(lineage);
    assertSessions();
    agentId = lineage.loaded.agentId;
    if (
      lineage.loaded.canonicalKey === source.loaded.canonicalKey &&
      agentId === source.loaded.agentId
    ) {
      break;
    }
    const entry = lineage.readCurrent().entry;
    const parent = entry?.parentSessionKey ?? entry?.spawnedBy;
    if (!parent) {
      throw new Error("The publishing session is not a child of this conversation.");
    }
    key = parent;
  }
  assertSessions();
  return { selected, assertCurrent: assertSessions };
}
