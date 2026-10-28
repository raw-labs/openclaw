import type { AsyncWorkScope } from "../plugin-sdk/concurrency-runtime.js";
import type { OpenClawConfig } from "../plugin-sdk/config-contracts.js";
import type {
  ControlUiSessionPullRequestSnapshot,
  ControlUiSessionPullRequests,
  NativeGitHubSessionReads as RepositorySessionReads,
  RepositorySessionSourceScope,
  PreparedNativeGitHubSessionRead as PreparedRepositorySessionRead,
} from "../plugin-sdk/native-github-session-read.js";
import { isIncognitoSessionKey } from "../plugin-sdk/session-key-runtime.js";
import {
  prepareControlUiSessionPrServiceTarget,
  type ControlUiSessionPrTarget,
  type ControlUiSessionPrRead,
  type ControlUiSessionPrReadContext,
} from "./control-ui-session-pr-target.js";
import type { ControlUiSessionPullRequestsParams } from "./control-ui-session-prs.js";

export type LoadSessionPullRequests = (
  params: ControlUiSessionPullRequestsParams,
  cacheSignal: AbortSignal | undefined,
  read: ControlUiSessionPrReadContext,
) => Promise<ControlUiSessionPullRequests>;

export async function loadSessionPullRequests(
  params: ControlUiSessionPullRequestsParams,
  cacheSignal: AbortSignal | undefined,
  read: ControlUiSessionPrReadContext,
): Promise<ControlUiSessionPullRequests> {
  read.assertCurrent();
  const { loadControlUiSessionPullRequests } = await import("./control-ui-session-prs.js");
  return loadControlUiSessionPullRequests(params, { cacheSignal, read });
}

export function pushedSnapshot(
  result: ControlUiSessionPullRequests,
): ControlUiSessionPullRequestSnapshot {
  return {
    ...result,
    status: result.status ?? (result.rateLimited ? "rate-limited" : "ready"),
  };
}

export const UNAVAILABLE_SNAPSHOT: ControlUiSessionPullRequestSnapshot = {
  pullRequests: [],
  rateLimited: false,
  status: "unavailable",
};

export type PreparedSessionPrState = {
  connIds: Set<string>;
  target: ControlUiSessionPrTarget;
  cacheLifetime: AbortController;
  sourceIdentity?: string;
  snapshot?: ControlUiSessionPullRequestSnapshot;
  branchSnapshot?: ControlUiSessionPullRequestSnapshot;
  prepared?: boolean;
  assertReadAuthority?: () => void;
};

export type WatchedSessionPrState = PreparedSessionPrState & {
  sessionKeysByConnId: Map<string, Set<string>>;
  refreshedAt?: number;
  cancelRefresh?: () => void;
  delivery?: Promise<void>;
};

export type WatchedSessionPr = {
  readCurrent: ControlUiSessionPrRead;
  target: ControlUiSessionPrTarget;
  deliveredHash?: string;
  refreshPending?: boolean;
};

/** Acquire through the actual prepared viewer; cached observations never carry private authority. */
export function createControlUiSessionPrSourceRead(deps: {
  reads: Pick<RepositorySessionReads, "withSource">;
  keyStates: ReadonlyMap<string, WatchedSessionPrState>;
  currentWatcher: (
    connId: string,
    sessionKey: string,
  ) => Promise<{ target: ControlUiSessionPrTarget } | undefined>;
}) {
  return async <T>(
    target: ControlUiSessionPrTarget,
    operation: (
      assertCurrent: () => void,
      sourceIdentity: string,
      sourceScope: RepositorySessionSourceScope,
      selectedRead?: PreparedRepositorySessionRead,
    ) => Promise<T>,
  ) => {
    const run = (source: RepositorySessionSourceScope) =>
      operation(source.assertCurrent, source.identity, source, target.read);
    if (target.read) {
      return await target.read.withSource(run);
    }
    if (!isIncognitoSessionKey(target.params.sessionKey) && !target.ownGitHubProfileId) {
      return await deps.reads.withSource(target.observation, run);
    }

    // Private sources require a live viewer; observations never grant background access.
    const state = deps.keyStates.get(target.identity);
    if (state) {
      for (const [connId, keys] of state.sessionKeysByConnId) {
        const sessionKeys = Array.from(keys);
        for (const key of sessionKeys) {
          state.cacheLifetime.signal.throwIfAborted();
          const watched = await deps.currentWatcher(connId, key);
          const read = watched?.target.read;
          if (!read || watched.target.identity !== target.identity) {
            continue;
          }
          try {
            return await read.withSource((source) =>
              operation(source.assertCurrent, source.identity, source, read),
            );
          } catch (error) {
            try {
              read.assertCurrent();
            } catch {
              // A departing viewer can hand this read-only load to another current viewer.
              continue;
            }
            throw error;
          }
        }
      }
    }
    throw new Error("Session pull-request watchers changed");
  };
}

/** Retain only branch facts across audience/mode changes on the same physical source. */
export function retainControlUiSessionPrBranchSnapshot(
  state: PreparedSessionPrState,
  previous: PreparedSessionPrState | undefined,
) {
  if (
    !previous?.target.branchIdentity ||
    previous.target.branchIdentity !== state.target.branchIdentity ||
    previous.target.taskAudienceKey !== state.target.taskAudienceKey
  ) {
    return;
  }
  state.sourceIdentity ??= previous.sourceIdentity;
  if (
    state.sourceIdentity === previous.sourceIdentity &&
    previous.branchSnapshot &&
    state.branchSnapshot !== previous.branchSnapshot
  ) {
    state.branchSnapshot = previous.branchSnapshot;
    state.assertReadAuthority = previous.assertReadAuthority;
    state.snapshot = undefined;
  }
}

/** Background readers publish into the subscription owner's existing cells and concurrency. */
export function createControlUiSessionPrPreparedRead(deps: {
  scope: Pick<AsyncWorkScope, "isClosing" | "track">;
  limit: <T>(run: () => Promise<T>) => Promise<T>;
  withSource: <T>(
    target: ControlUiSessionPrTarget,
    operation: (
      assertCurrent: () => void,
      sourceIdentity: string,
      sourceScope: RepositorySessionSourceScope,
      selectedRead?: PreparedRepositorySessionRead,
    ) => Promise<T>,
  ) => Promise<T>;
  load: LoadSessionPullRequests;
  keyStates: Map<string, WatchedSessionPrState>;
  reads: RepositorySessionReads;
  getConfig: () => OpenClawConfig;
}) {
  const { scope, limit, withSource, load, keyStates } = deps;
  const stateForTarget = (
    target: ControlUiSessionPrTarget,
    sourceIdentity?: string,
    retained?: WatchedSessionPrState,
  ) => {
    // Shared snapshots outlive individual viewers; authority stays only in each watched reader.
    const { assertCurrent: _assertCurrent, read: _read, ...preparedTarget } = target;
    const previous = keyStates.get(target.identity);
    if (
      previous?.target.identity === target.identity &&
      (sourceIdentity === undefined ||
        previous.sourceIdentity === undefined ||
        previous.sourceIdentity === sourceIdentity)
    ) {
      previous.target = preparedTarget;
      previous.sourceIdentity ??= sourceIdentity;
      retainControlUiSessionPrBranchSnapshot(previous, retained);
      return previous;
    }
    previous?.cancelRefresh?.();
    previous?.cacheLifetime.abort(null);
    const state: WatchedSessionPrState = {
      connIds: new Set(previous?.connIds),
      sessionKeysByConnId: new Map(previous?.sessionKeysByConnId),
      target: preparedTarget,
      prepared: previous?.prepared,
      sourceIdentity,
      cacheLifetime: new AbortController(),
    };
    retainControlUiSessionPrBranchSnapshot(state, retained);
    keyStates.set(target.identity, state);
    return state;
  };

  const preparing = new Map<WatchedSessionPrState, Promise<void>>();
  const preparedTargets = new Map<string, string>();
  const writeSnapshot = (
    state: WatchedSessionPrState,
    snapshot: ControlUiSessionPullRequestSnapshot,
  ) => {
    const changed = JSON.stringify(state.snapshot) !== JSON.stringify(snapshot);
    state.snapshot = snapshot;
    if (changed && state.prepared) {
      deps.reads.invalidate(state.target.params);
    }
  };

  const publishBranchSnapshot = (
    target: ControlUiSessionPrTarget,
    snapshot: ControlUiSessionPullRequestSnapshot,
  ) => {
    if (!target.branchIdentity || target.taskReceiptsOnly) {
      return;
    }
    const state = keyStates.get(target.identity);
    if (state) {
      state.branchSnapshot = snapshot;
    }
    const branchState = keyStates.get(target.branchIdentity);
    if (branchState) {
      writeSnapshot(branchState, snapshot);
    }
  };
  const publishSnapshot = (
    state: WatchedSessionPrState,
    snapshot: ControlUiSessionPullRequestSnapshot,
    assertReadAuthority?: () => void,
  ) => {
    state.assertReadAuthority = assertReadAuthority;
    writeSnapshot(state, snapshot);
    // Branch-only loaders (including injected ones) need no separate projection callback.
    if (!snapshot.taskPullRequests) {
      publishBranchSnapshot(state.target, snapshot);
    }
  };

  const read = (
    target: ControlUiSessionPrTarget,
    assertCurrent: () => void,
    projection?: ControlUiSessionPrReadContext["projection"],
  ): Promise<ControlUiSessionPullRequestSnapshot> => {
    const state = keyStates.get(target.identity);
    const previous = state?.snapshot;
    let assertReadAuthority: (() => void) | undefined;
    const assertActive = () => {
      if (scope.isClosing) {
        throw new Error("Session pull-request owner is closed");
      }
      assertCurrent();
      target.assertCurrent?.();
      assertReadAuthority?.();
    };
    const publish = (snapshot: ControlUiSessionPullRequestSnapshot) => {
      // A retry may replace stale facts, but never a newer watcher publication.
      if (
        projection !== "publication" &&
        state?.prepared &&
        keyStates.get(target.identity) === state &&
        state.snapshot === previous &&
        state.target.identity === target.identity
      ) {
        publishSnapshot(state, snapshot, assertReadAuthority);
      }
    };
    assertActive();
    return scope.track(() =>
      limit(async () => {
        assertActive();
        return await withSource(
          target,
          async (assertSourceCurrent, sourceIdentity, sourceScope) => {
            const assertReadCurrent = () => {
              assertActive();
              assertSourceCurrent();
            };
            assertReadCurrent();
            try {
              const result = await load(target.params, undefined, {
                target,
                sourceIdentity,
                sourceScope,
                projection,
                onBranchRead: (branch) => {
                  assertReadCurrent();
                  publishBranchSnapshot(target, pushedSnapshot(branch));
                },
                assertCurrent: assertReadCurrent,
                retainReadAuthority: (guard) => {
                  assertReadAuthority = guard;
                },
              });
              assertReadCurrent();
              const snapshot = pushedSnapshot(result);
              publish(snapshot);
              return snapshot;
            } catch {
              assertReadCurrent();
              publish(UNAVAILABLE_SNAPSHOT);
              return { ...UNAVAILABLE_SNAPSHOT };
            }
          },
        );
      }),
    );
  };
  const readPrepared = (target: ControlUiSessionPrTarget, admitLoad?: () => boolean) => {
    if (scope.isClosing) {
      return undefined;
    }
    const session = JSON.stringify([target.params.agentId, target.params.sessionKey]);
    const previousIdentity = preparedTargets.get(session);
    if (previousIdentity && previousIdentity !== target.identity) {
      const previous = keyStates.get(previousIdentity);
      if (previous) {
        previous.prepared = false;
        if (previous.connIds.size === 0) {
          previous.cacheLifetime.abort(null);
          keyStates.delete(previousIdentity);
        }
      }
    }
    preparedTargets.set(session, target.identity);
    const state = stateForTarget(target);
    const preparedTarget = state.target;
    state.prepared = true;
    // Bootstrap a cold service cell from an active viewer's branch-only publication.
    // Later viewer refreshes update this cell directly; audience/task fields never cross.
    if (!state.snapshot) {
      for (const candidate of keyStates.values()) {
        if (candidate.target.branchIdentity === target.identity && candidate.branchSnapshot) {
          state.snapshot = candidate.branchSnapshot;
          break;
        }
      }
    }
    if (target.source === null) {
      state.snapshot ??= { pullRequests: [], rateLimited: false, status: "ready" };
    }
    if (
      (!state.snapshot || state.snapshot.status !== "ready" || state.snapshot.rateLimited) &&
      !preparing.has(state) &&
      (!admitLoad || admitLoad())
    ) {
      const promise = scope
        .track(async () => {
          const current = await limit(async () => {
            if (scope.isClosing || keyStates.get(preparedTarget.identity) !== state) {
              return undefined;
            }
            return prepareControlUiSessionPrServiceTarget(
              deps.reads,
              deps.getConfig,
              preparedTarget.params,
            );
          });
          if (!current) {
            return;
          }
          const assertCurrent = () => {
            if (
              scope.isClosing ||
              keyStates.get(preparedTarget.identity) !== state ||
              current.identity !== preparedTarget.identity
            ) {
              throw new Error("Prepared session pull-request target changed");
            }
            current.assertCurrent?.();
          };
          assertCurrent();
          await read(current, assertCurrent);
        })
        .catch(() => {})
        .finally(() => preparing.delete(state));
      preparing.set(state, promise);
    }
    return state.snapshot;
  };

  const unsubscribeFacts = deps.reads.subscribeChanges((change) => {
    if (change.kind === "publications") {
      return;
    }
    const affected =
      change.kind === "session"
        ? [...keyStates].filter(([, state]) => state.target.params.sessionKey === change.sessionKey)
        : keyStates;
    const invalidated: Array<ControlUiSessionPrTarget["params"]> = [];
    for (const [key, state] of affected) {
      state.branchSnapshot = undefined;
      if (state.prepared) {
        state.snapshot = undefined;
        if (state.connIds.size === 0) {
          state.cacheLifetime.abort(null);
          keyStates.delete(key);
        }
        invalidated.push(state.target.params);
      }
    }
    if (change.kind !== "session") {
      for (const query of invalidated) {
        deps.reads.invalidate(query);
      }
    }
  });

  return {
    stateForTarget,
    read,
    readPrepared,
    publishSnapshot,
    publishBranchSnapshot,
    settle: () => Promise.allSettled(preparing.values()),
    stop: unsubscribeFacts,
  };
}

/** Index each requested key on the cell that owns its snapshot. */
export function addControlUiSessionPrMembership(
  state: Pick<PreparedSessionPrState, "connIds"> & {
    sessionKeysByConnId: Map<string, Set<string>>;
  },
  connId: string,
  sessionKey: string,
): void {
  let keys = state.sessionKeysByConnId.get(connId);
  if (!keys) {
    keys = new Set();
    state.sessionKeysByConnId.set(connId, keys);
  }
  keys.add(sessionKey);
  state.connIds.add(connId);
}
/** Unused cells retire through the owner retaining their prepared readers. */
export function retireControlUiSessionPrState<
  State extends PreparedSessionPrState & { cancelRefresh?: () => void },
>(state: State | undefined, keyStates: Map<string, State>): void {
  if (!state || state.prepared || state.connIds.size > 0) {
    return;
  }
  state.cancelRefresh?.();
  state.cacheLifetime.abort(null);
  if (keyStates.get(state.target.identity) === state) {
    keyStates.delete(state.target.identity);
  }
}
