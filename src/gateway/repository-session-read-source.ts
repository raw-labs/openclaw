import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runGitReadOperation } from "../infra/git-read-cache.js";
import { withControlUiSessionPrSource } from "./control-ui-session-pr-source.js";
import type {
  PreparedRepositorySessionRead,
  RepositorySessionObservation,
  RepositorySessionSourceScope,
} from "./repository-session-read.types.js";
import type { MaterializedRow } from "./session-row-projection-record.js";
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";

type SelectedSession = {
  cfg: OpenClawConfig;
  agentId: string;
  canonicalKey: string;
  storePath: string;
  readSource?: { agentId: string; path: string };
  entry: MaterializedRow["entry"] | undefined;
};

/** This projection is data only: it cannot read, authorize, or retain an operation. */
export function observeSelectedRepositorySession(
  selected: SelectedSession,
  repository: MaterializedRow["materialized"]["row"]["repository"] | null,
): RepositorySessionObservation | undefined {
  const { cfg, agentId, canonicalKey, storePath, readSource, entry } = selected;
  if (!entry?.sessionId || !storePath || !readSource) {
    return undefined;
  }
  const session = Object.freeze({
    sessionId: entry.sessionId,
    sessionKey: canonicalKey,
    agentId,
    ...(entry.lifecycleRevision ? { lifecycleRevision: entry.lifecycleRevision } : {}),
  });
  const root = entry.repositoryWorkspaceId
    ? undefined
    : resolveSessionWorkspaceRoots(cfg, agentId, entry).diffCwd;
  const source = entry.repositoryWorkspaceId
    ? repository
      ? Object.freeze({
          kind: "repository" as const,
          url: repository.url,
          branch: repository.branch,
        })
      : null
    : root
      ? Object.freeze({ kind: "checkout" as const, root })
      : null;
  const identity = JSON.stringify([
    agentId,
    canonicalKey,
    storePath,
    readSource.agentId,
    readSource.path,
    entry.sessionId,
    entry.lifecycleRevision,
    entry.repositoryWorkspaceId,
    entry.worktree?.id,
    source,
  ]);
  return Object.freeze({
    session,
    source,
    identity,
    branchIdentity: identity,
    ...(entry.worktree
      ? {
          worktree: Object.freeze({
            id: entry.worktree.id,
            repoRoot: entry.worktree.repoRoot,
            branch: entry.worktree.branch,
          }),
        }
      : {}),
    refreshIndex: Boolean(entry.worktree && !entry.repositoryWorkspaceId),
  });
}

/** Physical custody and live selection are required separately; neither is reconstructed from data. */
export function prepareSelectedRepositorySessionRead(
  selected: SelectedSession,
  repository: MaterializedRow["materialized"]["row"]["repository"] | null,
  owner: {
    assertCurrent: () => void;
    runSource: <T>(run: () => Promise<T>) => Promise<T>;
  },
): PreparedRepositorySessionRead | undefined {
  owner.assertCurrent();
  const observed = observeSelectedRepositorySession(selected, repository);
  const readSource = selected.readSource;
  if (!observed || !readSource) {
    return undefined;
  }
  const { assertCurrent, runSource } = owner;
  const { source } = observed;
  return Object.freeze({
    ...observed,
    includesTaskPublications: false,
    assertCurrent,
    async withSource<T>(
      operation: (scope: RepositorySessionSourceScope) => Promise<T>,
    ): Promise<T> {
      assertCurrent();
      return await runSource(() =>
        withControlUiSessionPrSource(readSource, async (assertPhysicalCurrent, identity) => {
          let active = true;
          const assertSourceCurrent = () => {
            if (!active) {
              throw new Error("Session PR source changed or closed. Retry the request.");
            }
            assertCurrent();
            assertPhysicalCurrent();
          };
          const scope: RepositorySessionSourceScope = {
            identity,
            assertCurrent: assertSourceCurrent,
            async readCheckoutRevision(input) {
              assertSourceCurrent();
              if (source?.kind !== "checkout") {
                return null;
              }
              const result = await runGitReadOperation({
                type: "checkout.revision",
                input: { ...input, root: source.root },
              });
              assertSourceCurrent();
              return result;
            },
            async readCheckoutBranchFacts(input, refresh = false) {
              assertSourceCurrent();
              if (source?.kind !== "checkout") {
                return undefined;
              }
              const result = await runGitReadOperation(
                {
                  type: "pull-request.branch-facts",
                  input: { ...input, root: source.root, refreshIndex: observed.refreshIndex },
                },
                { refresh },
              );
              assertSourceCurrent();
              return result;
            },
            async readCheckoutFacts(refresh = false) {
              assertSourceCurrent();
              if (source?.kind !== "checkout") {
                return undefined;
              }
              const result = await runGitReadOperation(
                { type: "checkout.context", input: { root: source.root } },
                { refresh },
              );
              assertSourceCurrent();
              return result ?? undefined;
            },
          };
          try {
            assertSourceCurrent();
            const result = await operation(scope);
            assertSourceCurrent();
            return result;
          } finally {
            active = false;
          }
        }),
      );
    },
    async readTaskPublications() {
      assertCurrent();
      return { receipts: [], count: 0, branchMatchCount: 0 };
    },
  });
}

/** Existing synchronous presentation callers receive observations, never unguarded read handles. */
export function observeProjectedRepositorySession(cfg: OpenClawConfig, record: MaterializedRow) {
  const { storePath, agentId } = record.storeTarget;
  return observeSelectedRepositorySession(
    {
      cfg,
      agentId: record.agentId,
      canonicalKey: record.key,
      storePath,
      readSource: { agentId, path: storePath },
      entry: record.entry,
    },
    record.materialized.row.repository ?? null,
  );
}
