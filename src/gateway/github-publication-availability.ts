import { isDeepStrictEqual } from "node:util";
import { SessionWorktreeSourceChangedError } from "../agents/worktrees/errors.js";
import {
  captureWorktreeRegistryReadGuard,
  readLiveRegistryWorktreeByOwner,
} from "../agents/worktrees/registry-read.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { readRuntimeConfig as getRuntimeConfig } from "../config/runtime-snapshot.js";
import { retainPreparedSessionEntryPredicate } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "../config/sessions/session-actor-storage-binding.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntrySnapshotField } from "../config/sessions/session-entry-snapshot-values.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createStaleWhileRevalidateCache } from "../infra/stale-while-revalidate-cache.js";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import { prepareGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import type { PreparedRepositoryWorkspace } from "../state/session-repository-workspaces.publication.js";
import {
  RepositoryPublicationSessionChangedError,
  RepositoryPublicationWorkspaceChangedError,
} from "./github-publication-errors.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import { isSupportedGitHubOrigin } from "./github-publication-identity.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

export type PublicationSessionIdentity = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  lifecycleRevision?: string | null;
};
type ExpectedWorktree = { worktreeId: string; repositoryFingerprint: string; branch: string };
/** Only publication/session identity facts cross the host boundary. */
export type RepositoryPublicationEntry = InternalSessionEntry;
export type RepositoryPublicationSessionRead = {
  agentId: string;
  canonicalKey: string;
  storePath: string;
  entry: RepositoryPublicationEntry | undefined;
};
export type RepositoryPublicationSessionTarget = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  storePath?: string;
  expectedLifecycleRevision?: string;
  expectedWriterRunId?: string;
};
type PublicationSessionRead = RepositoryPublicationSessionRead;

/** The selected publication metadata is invalidated by the session writer's receipts. */
export async function prepareGitHubPublicationSession(
  sessionKey: string,
  options: {
    agentId?: string;
    cfg?: OpenClawConfig;
    assertCurrent?: () => void;
    target?: RepositoryPublicationSessionTarget;
    fields?: readonly (keyof NonNullable<PublicationSessionRead["entry"]>)[];
    /** Saved snapshots a consumer compares; stored reads omit them by default. */
    projection?: readonly SessionEntrySnapshotField[];
  } = {},
) {
  const projection = options.projection ?? [];
  const fields = [
    ...(options.fields ??
      ([
        "sessionId",
        "lifecycleRevision",
        "archivedAt",
        "repositoryWorkspaceId",
        "worktree",
        "owner",
        "createdActor",
        "visibility",
        "incognito",
      ] as const)),
    ...(options.target?.expectedWriterRunId !== undefined ? (["activeWriterRunId"] as const) : []),
  ];
  let retained: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  let active = true;
  const scope = { sessionKey, agentId: options.agentId, storePath: options.target?.storePath };
  const assertCurrent = () => options.assertCurrent?.();
  const memory = captureSessionActorStorageOwner(scope, {
    assertCurrent,
    authorize: assertCurrent,
  });
  const readMemory =
    memory &&
    (() => ({
      canonicalKey: sessionKey,
      agentId: memory.agentId,
      storePath: memory.path,
      entry: readCapturedSessionActorEntry(memory, sessionKey),
    }));
  const retain = (
    databaseIdentity: string,
    key: string,
    entry: PublicationSessionRead["entry"],
  ) => {
    retained = retainPreparedSessionEntryPredicate({
      databaseIdentity,
      sessionKey: key,
      entry,
      matches: (before, after) =>
        fields.every((field) => isDeepStrictEqual(before?.[field], after?.[field])),
    });
  };
  let loaded: PublicationSessionRead;
  try {
    if (readMemory) {
      loaded = readMemory();
    } else if (options.target?.storePath && options.target.agentId) {
      const storePath = options.target.storePath;
      const agentId = options.target.agentId;
      const storedKey = options.target.sessionKey ?? sessionKey;
      loaded = await withSessionEntryReadOnlyInWorker(
        { agentId, sessionKey: storedKey, storePath, projection },
        () => options.assertCurrent?.(),
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          if (typeof owner.source?.databaseIdentity === "string") {
            retain(`file:${owner.source.databaseIdentity}`, storedKey, read.value);
          }
          return { agentId, canonicalKey: sessionKey, storePath, entry: read.value };
        },
      );
    } else {
      loaded = await loadGatewaySessionEntryReadOnlyInWorker({
        cfg: options.cfg ?? getRuntimeConfig(),
        key: sessionKey,
        agentId: options.agentId,
        projection,
        assertActive: options.assertCurrent,
        onSelected(target) {
          const source = target.capturedReadSource;
          if (source && typeof source.databaseIdentity === "string") {
            retain(
              `file:${source.databaseIdentity}`,
              target.canonicalKey,
              findCanonicalStoreMatch(target.store, target.storeKeys)?.entry,
            );
          }
        },
      });
    }
  } catch (error) {
    retained?.release();
    throw error;
  }
  const release = () => {
    active = false;
    retained?.release();
  };
  const readCurrent = (): PublicationSessionRead => {
    options.assertCurrent?.();
    if (!active || (retained && !retained.isCurrent())) {
      throw new RepositoryPublicationSessionChangedError();
    }
    return readMemory
      ? readMemory()
      : { ...loaded, entry: retained ? retained.readRetainedEntry() : loaded.entry };
  };
  return {
    loaded,
    readCurrent,
    release,
    [Symbol.dispose]: release,
  };
}

type PublicationSessionOwner = ReturnType<typeof requirePublicationSessionOwner>;

function requirePublicationSessionOwner(
  params: PublicationSessionIdentity,
  loaded: PublicationSessionRead,
  allowArchived = false,
) {
  const entry = loaded.entry;
  if (
    loaded.agentId !== params.agentId ||
    loaded.canonicalKey !== params.sessionKey ||
    entry?.sessionId !== params.sessionId ||
    (!allowArchived && entry.archivedAt !== undefined) ||
    (params.lifecycleRevision !== undefined &&
      (entry.lifecycleRevision ?? null) !== params.lifecycleRevision)
  ) {
    throw new RepositoryPublicationSessionChangedError();
  }
  return { ...loaded, entry };
}

function requirePublicationWorktreeOwner(
  loaded: PublicationSessionOwner,
  worktree: ManagedWorktreeRecord | undefined,
  expected?: ExpectedWorktree,
  allowExistingPullRequest = false,
) {
  const entry = loaded.entry;
  const pullRequest = entry.worktree?.githubPullRequest;
  if (
    pullRequest &&
    (!allowExistingPullRequest ||
      !pullRequest.preparedHeadCommit ||
      pullRequest.preparedHeadCommit !== pullRequest.head.commit)
  ) {
    throw new RepositoryPublicationWorkspaceChangedError(
      allowExistingPullRequest
        ? "Finish preparing the original PR source before publication; saved work was preserved."
        : "This publication path cannot update an imported PR; use shared publication after preparation.",
    );
  }
  if (
    !entry.worktree?.id ||
    !worktree ||
    worktree.removedAt !== undefined ||
    worktree.id !== entry.worktree.id ||
    worktree.ownerKind !== "session" ||
    worktree.ownerId !== loaded.canonicalKey ||
    worktree.branch !== entry.worktree.branch ||
    worktree.repoRoot !== entry.worktree.repoRoot
  ) {
    throw new RepositoryPublicationSessionChangedError();
  }
  if (
    expected &&
    (worktree.id !== expected.worktreeId ||
      worktree.repoFingerprint !== expected.repositoryFingerprint ||
      (pullRequest?.head.branch ?? worktree.branch) !== expected.branch)
  ) {
    throw new RepositoryPublicationWorkspaceChangedError(
      "Repository publication workspace authority changed.",
    );
  }
  return { loaded, worktree, publicationBranch: pullRequest?.head.branch ?? worktree.branch };
}

function rejectChangedPublicationWorktree(error: unknown): never {
  if (error instanceof SessionWorktreeSourceChangedError) {
    throw new RepositoryPublicationWorkspaceChangedError(error.message);
  }
  throw error;
}

function preparePublicationWorktreeRead(
  loaded: PublicationSessionOwner,
  context: OpenClawStateWorkerContext,
  session: Pick<Awaited<ReturnType<typeof prepareGitHubPublicationSession>>, "readCurrent">,
  expected?: ExpectedWorktree,
  allowExistingPullRequest = false,
) {
  const identity = {
    sessionId: loaded.entry.sessionId,
    sessionKey: loaded.canonicalKey,
    agentId: loaded.agentId,
    lifecycleRevision: loaded.entry.lifecycleRevision ?? null,
  };
  const workspaceId = loaded.entry.repositoryWorkspaceId;
  const selection = expected ? { ...expected } : undefined;
  return async () => {
    const acceptRead = captureWorktreeRegistryReadGuard(context, "publication");
    const worktree = await readLiveRegistryWorktreeByOwner(context, "session", identity.sessionKey);
    let assertRow: () => void;
    try {
      assertRow = acceptRead(worktree);
    } catch (error) {
      rejectChangedPublicationWorktree(error);
    }
    context.admission.assertCurrent();
    if (!worktree) {
      throw new RepositoryPublicationSessionChangedError();
    }
    const current = requirePublicationSessionOwner(identity, session.readCurrent());
    if (current.entry.repositoryWorkspaceId !== workspaceId) {
      throw new RepositoryPublicationSessionChangedError();
    }
    const assertCurrent = () => {
      context.admission.assertCurrent();
      const latest = requirePublicationSessionOwner(identity, session.readCurrent());
      if (latest.entry.repositoryWorkspaceId !== workspaceId) {
        throw new RepositoryPublicationSessionChangedError();
      }
      try {
        assertRow();
      } catch (error) {
        rejectChangedPublicationWorktree(error);
      }
      return requirePublicationWorktreeOwner(latest, worktree, selection, allowExistingPullRequest);
    };
    return {
      ...requirePublicationWorktreeOwner(current, worktree, selection, allowExistingPullRequest),
      assertCurrent,
      assertRegistryCurrent: assertRow,
    };
  };
}

export async function readGitHubPublicationWorktreeOwner(
  params: PublicationSessionIdentity & {
    expected?: ExpectedWorktree;
    allowExistingPullRequest?: boolean;
  },
) {
  const context = captureOpenClawStateWorkerContext();
  const session = await prepareGitHubPublicationSession(params.sessionKey, {
    agentId: params.agentId,
    assertCurrent: () => context.admission.assertCurrent(),
  });
  try {
    const owner = await preparePublicationWorktreeRead(
      requirePublicationSessionOwner(params, session.readCurrent()),
      context,
      session,
      params.expected,
      params.allowExistingPullRequest,
    )();
    return { ...owner, release: session.release, [Symbol.dispose]: session.release };
  } catch (error) {
    session.release();
    throw error;
  }
}

function resolveRepositoryPublicationWorkspaceOwner(
  params: PublicationSessionIdentity,
  prepared: PreparedRepositoryWorkspace | undefined,
  session: Pick<Awaited<ReturnType<typeof prepareGitHubPublicationSession>>, "readCurrent">,
) {
  const loaded = requirePublicationSessionOwner(params, session.readCurrent());
  const workspaceId = loaded.entry.repositoryWorkspaceId;
  if (!workspaceId) {
    throw new RepositoryPublicationSessionChangedError();
  }
  const workspace = prepared?.current();
  if (
    !workspace ||
    workspace.workspaceId !== workspaceId ||
    workspace.agentId !== params.agentId ||
    workspace.sessionKey !== params.sessionKey
  ) {
    throw new Error("Repository publication session repository owner changed.");
  }
  return { kind: "repository" as const, loaded, workspace };
}

export async function prepareGitHubPublicationWorkspaceOwner(
  params: PublicationSessionIdentity,
  options: {
    sessionTarget?: RepositoryPublicationSessionTarget;
    assertCurrent?: () => void;
    allowExistingPullRequest?: boolean;
  } = {},
) {
  const context = captureOpenClawStateWorkerContext();
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.assertCurrent?.();
  };
  assertCurrent();
  const target = options.sessionTarget ? { ...options.sessionTarget } : undefined;
  if (target) {
    const logical =
      target.sessionKey &&
      resolveSessionStoreIdentity({
        cfg: getRuntimeConfig(),
        sessionKey: target.sessionKey,
        agentId: target.agentId,
      });
    if (
      !target.storePath ||
      !logical ||
      logical.agentId !== params.agentId ||
      logical.canonicalKey !== params.sessionKey
    ) {
      throw new RepositoryPublicationSessionChangedError();
    }
  }
  const session = await prepareGitHubPublicationSession(params.sessionKey, {
    agentId: params.agentId,
    assertCurrent,
    target,
  });
  try {
    const snapshot = session.readCurrent();
    if (
      target &&
      (target.agentId !== params.agentId ||
        target.sessionId !== params.sessionId ||
        (target.expectedLifecycleRevision !== undefined &&
          snapshot.entry?.lifecycleRevision !== target.expectedLifecycleRevision) ||
        (target.expectedWriterRunId !== undefined &&
          snapshot.entry?.activeWriterRunId !== target.expectedWriterRunId))
    ) {
      throw new RepositoryPublicationSessionChangedError();
    }
    const loaded = requirePublicationSessionOwner(params, snapshot);
    const workspaceId = loaded.entry.repositoryWorkspaceId;
    if (!workspaceId && !loaded.entry.worktree?.id) {
      throw new RepositoryPublicationSessionChangedError();
    }
    const identity = { ...params, lifecycleRevision: loaded.entry.lifecycleRevision ?? null };
    const readWorktree = preparePublicationWorktreeRead(
      loaded,
      context,
      session,
      undefined,
      options.allowExistingPullRequest,
    );
    const prepared = workspaceId
      ? await getSessionRepositoryWorkspaceStore().prepare(workspaceId)
      : undefined;
    const validate = <T extends { loaded: PublicationSessionOwner }>(owner: T) => {
      assertCurrent();
      if (
        owner.loaded.storePath !== loaded.storePath ||
        owner.loaded.entry.repositoryWorkspaceId !== workspaceId ||
        (target?.expectedWriterRunId !== undefined &&
          owner.loaded.entry.activeWriterRunId !== target.expectedWriterRunId)
      ) {
        throw new RepositoryPublicationSessionChangedError();
      }
      return owner;
    };
    let witness: Awaited<ReturnType<typeof readWorktree>> | undefined;
    const current = () => {
      if (workspaceId) {
        return validate(resolveRepositoryPublicationWorkspaceOwner(identity, prepared, session));
      }
      if (!witness) {
        throw new RepositoryPublicationSessionChangedError();
      }
      return validate({ kind: "worktree" as const, ...witness, ...witness.assertCurrent() });
    };
    const read = async () => {
      if (!workspaceId) {
        witness = await readWorktree();
      }
      return current();
    };
    return {
      initial: await read(),
      read,
      current,
      // Only repository owners expose synchronous current facts; worktrees use the worker reader.
      currentRepository: () =>
        validate(resolveRepositoryPublicationWorkspaceOwner(identity, prepared, session)),
      release: session.release,
      [Symbol.dispose]: session.release,
    };
  } catch (error) {
    session.release();
    throw error;
  }
}

export async function hasGitHubPublicationRepositoryWorkspace(params: PublicationSessionIdentity) {
  const prepared = await prepareGitHubPublicationWorkspaceOwner(params, {
    allowExistingPullRequest: true,
  });
  using _ = { [Symbol.dispose]: () => prepared.release() };

  return prepared.initial.kind === "repository";
}

async function acceptedRepositoryPublicationSession(row: {
  requestId: string;
  kind: "shared" | "personal";
  sessionId: string;
  sessionKey: string;
  agentId: string;
  worktreeId: string;
  repositoryFingerprint: string;
  branch: string;
}) {
  const authority = await prepareGitHubPublicationSessionLifecycle({
    publicationKind: row.kind,
    requestId: row.requestId,
  }).catch((cause: unknown) => {
    throw new GitHubPublicationRecoveryPendingError(
      "GitHub publication lifecycle authority is unavailable; retry recovery.",
      { cause },
    );
  });
  const readLifecycle = () => {
    try {
      return authority.readCurrent();
    } catch (cause) {
      // Pending writes deny effects without proving that the accepted request failed.
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication lifecycle authority is unavailable; retry recovery.",
        { cause },
      );
    }
  };
  const lifecycle = readLifecycle();
  if (!lifecycle) {
    throw new RepositoryPublicationSessionChangedError();
  }
  return {
    sessionId: row.sessionId,
    sessionKey: row.sessionKey,
    agentId: row.agentId,
    lifecycleRevision: lifecycle.lifecycle_revision,
    assertLifecycleCurrent: readLifecycle,
    expected: {
      worktreeId: row.worktreeId,
      repositoryFingerprint: row.repositoryFingerprint,
      branch: row.branch,
    },
  };
}

export async function readAcceptedRepositoryPublicationWorktree(
  row: Parameters<typeof acceptedRepositoryPublicationSession>[0],
) {
  const identity = await acceptedRepositoryPublicationSession(row);
  const owner = await readGitHubPublicationWorktreeOwner({
    ...identity,
    allowExistingPullRequest: row.kind !== "personal",
  });
  return {
    ...owner,
    assertCurrent: () => {
      identity.assertLifecycleCurrent();
      return owner.assertCurrent();
    },
  };
}

/** Discovery validates the same registered repository identity as publication, without vendor I/O. */
export async function prepareGitHubPublicationRepositoryIdentity(params: {
  worktree: ManagedWorktreeRecord;
  assertCurrent: () => void;
}) {
  const { worktree, assertCurrent } = params;
  assertCurrent();
  const repositoryIdentity = await managedWorktrees.resolveRepositoryIdentity(worktree.path);
  assertCurrent();
  if (
    repositoryIdentity.checkoutRoot !== worktree.path ||
    repositoryIdentity.repoRoot !== worktree.repoRoot ||
    repositoryIdentity.fingerprint !== worktree.repoFingerprint
  ) {
    throw new RepositoryPublicationWorkspaceChangedError(
      "GitHub publication workspace repository changed.",
    );
  }
  return repositoryIdentity;
}

/** Resolve local branch and origin under the admitted publication checkout owner. */
export async function readRepositoryPublicationTargetFacts(params: {
  worktree: ManagedWorktreeRecord;
  assertCurrent: () => void;
}): Promise<{ originUrl: string; branch: string; baseRef: string }> {
  const identity = await prepareGitHubPublicationRepositoryIdentity(params);
  params.assertCurrent();
  const { requirePublicationCommand } = await import("./github-publication-git-transport.js");
  const branch = await requirePublicationCommand(
    ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
    { cwd: params.worktree.path, beforeRun: params.assertCurrent },
  );
  params.assertCurrent();
  if (branch !== params.worktree.branch) {
    throw new RepositoryPublicationWorkspaceChangedError("Repository publication branch changed.");
  }
  return { originUrl: identity.originUrl, branch, baseRef: params.worktree.baseRef };
}

// Discovery is best effort for 15 seconds; publication resolves the current Git repository again.
const repositoryTargets = createStaleWhileRevalidateCache<boolean>({
  maxEntries: 256,
  maxPending: Number.POSITIVE_INFINITY,
  ttlMs: 15_000,
  cacheable: (supported) => supported,
});

/** Qualify only the target; execution still owns branch, permission and publication checks. */
export async function hasSupportedGitHubPublicationTarget(
  session: PublicationSessionIdentity,
  assertCurrent: () => void,
  readSession: () => PublicationSessionRead,
): Promise<boolean> {
  assertCurrent();
  const context = captureOpenClawStateWorkerContext();
  const initial = requirePublicationSessionOwner(session, readSession(), true);
  context.admission.assertCurrent();
  if (initial.entry.archivedAt !== undefined) {
    return false;
  }
  const workspaceId = initial.entry.repositoryWorkspaceId;
  if (workspaceId) {
    const prepared = await getSessionRepositoryWorkspaceStore().prepare(workspaceId);
    const owner = resolveRepositoryPublicationWorkspaceOwner(session, prepared, {
      readCurrent: readSession,
    });
    return isSupportedGitHubOrigin(owner.workspace.url);
  }
  if (!initial.entry.worktree?.id) {
    return false;
  }
  const owner = await preparePublicationWorktreeRead(
    initial,
    context,
    { readCurrent: readSession },
    undefined,
    true,
  )();
  owner.assertCurrent();
  if (initial.entry.worktree?.githubPullRequest) {
    return true;
  }
  const { repoRoot, repoFingerprint } = owner.worktree;
  const key = JSON.stringify([context.admission.identity.key, repoRoot, repoFingerprint]);
  const load = async () => {
    // Resolve through a checkout because the shared root can be bare. Readers
    // share repository facts while retaining their own registry authority.
    const repository = await prepareGitHubPublicationRepositoryIdentity({
      worktree: owner.worktree,
      assertCurrent: () => context.admission.assertCurrent(),
    });
    return isSupportedGitHubOrigin(repository.originUrl);
  };
  const target = await repositoryTargets.read(key, load, { allowStale: false });
  owner.assertCurrent();
  return target.value;
}

export function readLocalGitHubPublicationWorktreeOwner(row: GitHubPublicationExecutionRow) {
  return readAcceptedRepositoryPublicationWorktree({
    requestId: row.request_id,
    kind: row.identity_source === "personal" ? "personal" : "shared",
    sessionId: row.session_id,
    sessionKey: row.session_key,
    agentId: row.agent_id,
    worktreeId: row.worktree_id,
    repositoryFingerprint: row.repository_fingerprint,
    branch: row.branch,
  });
}

export {
  currentGitHubPublicationConfig,
  prepareCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationOptionsIdentity,
  matchesCurrentGitHubPublicationIdentity,
  assertExpectedSharedGitHubPublisher,
} from "./github-publication-identity.js";
