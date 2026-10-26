import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import {
  observeSelectedRepositorySession,
  prepareSelectedRepositorySessionRead,
} from "./repository-session-read-source.js";
import type { PreparedRepositorySessionRead } from "./repository-session-read.types.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { createSessionListEntryFilter } from "./session-sharing.js";
import { retainGatewaySessionEntryReadOnly } from "./session-utils-read-lifetime.js";

/** Internal CI reads retain their existing visibility policy and exact durable/memory selection. */
export async function withRepositoryInternalSessionRead<T>(
  params: {
    getConfig: () => OpenClawConfig;
    query: { sessionKey: string; agentId?: string };
    assertCurrent: () => void;
  },
  consume: (read: PreparedRepositorySessionRead | undefined) => Promise<T>,
): Promise<T> {
  params.assertCurrent();
  const cfg = params.getConfig();
  const requested = resolveRequestedSessionAgentId(
    cfg,
    params.query.sessionKey,
    params.query.agentId,
  );
  if (!requested.ok) {
    return consume(undefined);
  }
  const fields = [
    "repositoryWorkspaceId",
    "worktree",
    "spawnedCwd",
    "spawnedWorkspaceDir",
    "pendingWorktree",
    "pendingProjectGitUrl",
    "deviceFolder",
  ] as const;
  const selected = await retainGatewaySessionEntryReadOnly(
    params.query.sessionKey,
    requested.agentId,
    (previous, current) =>
      fields.every((field) => isDeepStrictEqual(previous[field], current[field])),
    cfg,
    { exactRead: true },
  );
  try {
    params.assertCurrent();
    const entry = selected.entry;
    if (!entry?.sessionId) {
      return await consume(undefined);
    }
    const workspaceId = entry.repositoryWorkspaceId;
    const workspace = workspaceId
      ? await getSessionRepositoryWorkspaceStore().prepare(workspaceId)
      : undefined;
    const current = () => {
      params.assertCurrent();
      const currentConfig = params.getConfig();
      if (
        !selected.isCurrentAtResponse() ||
        createSessionListEntryFilter({ cfg: currentConfig, client: null })?.(
          selected.canonicalKey,
          entry,
        ) === false
      ) {
        return undefined;
      }
      const repository = workspace?.current();
      return {
        cfg: currentConfig,
        repository:
          repository?.workspaceId === workspaceId &&
          repository?.agentId === selected.agentId &&
          repository.sessionKey === selected.canonicalKey
            ? repository
            : null,
      };
    };
    const captured = current();
    if (!captured) {
      return await consume(undefined);
    }
    const observation = observeSelectedRepositorySession(
      { ...selected, cfg: captured.cfg },
      captured.repository,
    );
    if (!observation) {
      return await consume(undefined);
    }
    const assertCurrent = () => {
      const facts = current();
      if (
        !facts ||
        observeSelectedRepositorySession({ ...selected, cfg: facts.cfg }, facts.repository)
          ?.identity !== observation.identity
      ) {
        throw new Error("Repository session target changed");
      }
    };
    const read = prepareSelectedRepositorySessionRead(
      { ...selected, cfg: captured.cfg },
      captured.repository,
      { assertCurrent, runSource: (run) => run() },
    );
    return await consume(read);
  } finally {
    selected.release();
  }
}
