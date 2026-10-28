import {
  AsyncWorkScope,
  createConcurrencyLimit as pLimit,
} from "../plugin-sdk/concurrency-runtime.js";
import type { OpenClawConfig } from "../plugin-sdk/config-contracts.js";
import type {
  ControlUiSessionPullRequestSnapshot,
  ControlUiSessionPullRequestsChanged,
  NativeGitHubSessionReads as RepositorySessionReads,
  PreparedNativeGitHubSessionRead as PreparedRepositorySessionRead,
} from "../plugin-sdk/native-github-session-read.js";
import type { OpenClawPluginServiceContextV2 } from "../plugin-sdk/plugin-entry.js";
import { parseAgentSessionKey } from "../plugin-sdk/routing.js";
import {
  createControlUiSessionPrPreparedRead,
  addControlUiSessionPrMembership,
  retireControlUiSessionPrState,
  createControlUiSessionPrSourceRead,
  type WatchedSessionPrState as WatchedKeyState,
  type WatchedSessionPr as Watched,
  loadSessionPullRequests,
  pushedSnapshot,
  UNAVAILABLE_SNAPSHOT,
} from "./control-ui-session-pr-prepared-read.js";
import { createControlUiSessionPrRead } from "./control-ui-session-pr-target.js";

const CONTROL_UI_SESSION_PR_POLL_INTERVAL_MS = 60_000;
const CONTROL_UI_SESSION_PR_REFRESH_INTERVAL_MS = 10_000;
const CONTROL_UI_SESSION_PR_LOAD_CONCURRENCY = 4;

type SchedulerScope = Pick<
  OpenClawPluginServiceContextV2["scheduler"],
  "signal" | "now" | "schedule" | "beginClose" | "stop"
>;
type Scheduler = SchedulerScope & { scope: () => SchedulerScope };
type ScheduledJob = ReturnType<Scheduler["schedule"]>;
type SubscriptionDeps = {
  reads: RepositorySessionReads;
  getConfig: () => OpenClawConfig;
  scheduler: Scheduler;
};

export { parseControlUiSessionPullRequestsSubscribeParams } from "./control-ui-session-pr-subscription-params.js";

/**
 * Owns the union of connection replace-sets. Only this union drives GitHub
 * refreshes, so hidden/disconnected clients cannot leave orphan polling work.
 */
export function createControlUiSessionPullRequestSubscriptions(deps: SubscriptionDeps) {
  // A retained key keeps its work and delivery lifetime; removing it retires that cell.
  const subscriptions = new Map<string, Map<string, Watched>>();
  const replacements = new Set<Promise<void>>();
  const replacementGenerations = new Map<string, object>();
  const keyStates = new Map<string, WatchedKeyState>();
  const inflight = new Map<
    string,
    {
      promise: Promise<ControlUiSessionPullRequestSnapshot>;
      refresh: boolean;
      state: WatchedKeyState;
    }
  >();
  const scheduler = deps.scheduler.scope();
  const limit = pLimit(CONTROL_UI_SESSION_PR_LOAD_CONCURRENCY);
  // Loads revalidate watchers while holding a slot, so reads use their own bounded queue.
  const limitReads = pLimit(CONTROL_UI_SESSION_PR_LOAD_CONCURRENCY);
  const withSource = createControlUiSessionPrSourceRead({
    reads: deps.reads,
    keyStates,
    currentWatcher: (connId, sessionKey) => currentWatcher(connId, sessionKey),
  });
  let pollJob: ScheduledJob | undefined;
  const scope = new AsyncWorkScope();
  let stopPromise: Promise<void> | undefined;

  const removeMembership = (
    state: WatchedKeyState | undefined,
    connId: string,
    sessionKey: string,
  ) => {
    const keys = state?.sessionKeysByConnId.get(connId);
    keys?.delete(sessionKey);
    if (keys?.size === 0) {
      state?.sessionKeysByConnId.delete(connId);
      state?.connIds.delete(connId);
    }
    retireControlUiSessionPrState(state, keyStates);
  };

  const removeMemberships = (
    connId: string,
    previous: ReadonlyMap<string, Watched> | undefined,
    retained?: ReadonlyMap<string, Watched>,
  ) => {
    for (const key of previous?.keys() ?? []) {
      const oldTarget = previous?.get(key)?.target;
      if (oldTarget && retained?.get(key)?.target.identity !== oldTarget.identity) {
        const state = keyStates.get(oldTarget.identity);
        removeMembership(state, connId, key);
      }
    }
  };

  const prepared = createControlUiSessionPrPreparedRead({
    scope,
    limit,
    withSource,
    load: loadSessionPullRequests,
    keyStates,
    reads: deps.reads,
    getConfig: deps.getConfig,
  });

  const { stateForTarget } = prepared;

  const currentWatcher = async (connId: string, sessionKey: string) => {
    const watched = subscriptions.get(connId)?.get(sessionKey);
    const target = !deps.reads.isViewerConnected(connId)
      ? undefined
      : await limitReads(() => watched?.readCurrent());
    const subscription = subscriptions.get(connId);
    if (scope.isClosing || subscription?.get(sessionKey) !== watched) {
      return undefined;
    }
    if (!deps.reads.isViewerConnected(connId)) {
      unsubscribe(connId);
      return undefined;
    }
    if (!watched || !target) {
      if (watched?.target.ownGitHubProfileId && deps.reads.isViewerConnected(connId)) {
        deps.reads.invalidateViewer(connId);
      }
      subscription?.delete(sessionKey);
      const state = watched && keyStates.get(watched.target.identity);
      removeMembership(state, connId, sessionKey);
      if (subscription?.size === 0) {
        // Pruning an old watch does not retire a newer replacement still preparing its keys.
        subscriptions.delete(connId);
        if (subscriptions.size === 0) {
          pollJob?.cancel();
          pollJob = undefined;
        }
      }
      return undefined;
    }
    const changed = watched.target.identity !== target.identity;
    const previous = keyStates.get(watched.target.identity);
    const state = stateForTarget(target, undefined, previous);
    if (changed) {
      if (
        watched.target.ownGitHubIdentity &&
        watched.target.ownGitHubIdentity !== target.ownGitHubIdentity
      ) {
        deps.reads.invalidateViewer(connId);
      }
      removeMembership(previous, connId, sessionKey);
      watched.deliveredHash = undefined;
    }
    watched.target = target;
    addControlUiSessionPrMembership(state, connId, sessionKey);
    if (changed) {
      const replacement = scope
        .track(() => loadSnapshot(target.identity))
        .then(
          () => {},
          () => {},
        );
      replacements.add(replacement);
      void replacement.finally(() => replacements.delete(replacement));
    }
    return { watched, target };
  };

  const currentKeyState = async (cacheKey: string) => {
    const state = keyStates.get(cacheKey);
    // Revalidate only this audience's requested spellings, not every key on each connection.
    for (const [connId, keys] of state?.sessionKeysByConnId ?? []) {
      for (const key of keys) {
        await currentWatcher(connId, key);
      }
    }
    return keyStates.get(cacheKey);
  };

  const readTaskPublicationsForState =
    (state: WatchedKeyState): PreparedRepositorySessionRead["readTaskPublications"] =>
    async (input, signal) => {
      const viewers = [...state.sessionKeysByConnId].map(([connId, keys]) => ({
        connId,
        keys: [...keys],
      }));
      for (const { connId, keys } of viewers) {
        for (const key of keys) {
          const current = await currentWatcher(connId, key);
          const read = current?.target.read;
          if (
            !read ||
            current.target.identity !== state.target.identity ||
            current.target.taskAudienceKey !== state.target.taskAudienceKey
          ) {
            continue;
          }
          try {
            read.assertCurrent();
            const result = await read.readTaskPublications(input, signal);
            read.assertCurrent();
            return result;
          } catch (error) {
            // Only lost authority permits another audience-equivalent viewer; real worker failures propagate.
            try {
              read.assertCurrent();
            } catch {
              break;
            }
            throw error;
          }
        }
      }
      throw new Error("Session pull-request watchers changed");
    };

  const loadSnapshot = async (
    cacheKey: string,
    refresh = false,
  ): Promise<ControlUiSessionPullRequestSnapshot> => {
    const targetState = await currentKeyState(cacheKey);
    if (scope.isClosing || !targetState?.connIds.size) {
      return UNAVAILABLE_SNAPSHOT;
    }
    return withSource(
      targetState.target,
      async (assertSourceCurrent, sourceIdentity, sourceScope, selectedRead) => {
        const state = stateForTarget(targetState.target, sourceIdentity);
        const pending = inflight.get(cacheKey);
        if (pending) {
          if (pending.state === state && (!refresh || pending.refresh)) {
            return pending.promise;
          }
          // Serialize a forced refresh behind an older normal load so that older
          // poll results can never land after the refresh and revert its snapshot.
          await pending.promise;
          assertSourceCurrent();
          return (await currentKeyState(cacheKey)) === state
            ? loadSnapshot(cacheKey, refresh)
            : UNAVAILABLE_SNAPSHOT;
        }
        const promise = scope
          .track(async () => {
            const delay = refresh
              ? (state.refreshedAt ?? -Infinity) +
                CONTROL_UI_SESSION_PR_REFRESH_INTERVAL_MS -
                scheduler.now()
              : 0;
            if (delay > 0) {
              // Retain the source before this wait, without occupying a loader slot.
              await new Promise<void>((resolve) => {
                const refreshJob = scheduler.schedule({
                  id: `control-ui-session-pr-refresh:${cacheKey}`,
                  delayMs: delay,
                  run: resolve,
                });
                state.cancelRefresh = () => {
                  refreshJob.cancel();
                  resolve();
                };
              });
              state.cancelRefresh = undefined;
            }
            return await limit(async () => {
              if ((await currentKeyState(cacheKey)) !== state || state.connIds.size === 0) {
                return UNAVAILABLE_SNAPSHOT;
              }
              if (refresh) {
                state.refreshedAt = scheduler.now();
              }
              const assertReadCurrent = () => {
                assertSourceCurrent();
                if (scope.isClosing || keyStates.get(state.target.identity) !== state) {
                  throw new Error("Session pull-request watchers changed");
                }
                // Shared work survives a departing viewer while another prepared reader
                // still authorizes this exact source. Delivery keeps its per-viewer guard.
                for (const [connId, keys] of state.sessionKeysByConnId) {
                  if (!deps.reads.isViewerConnected(connId)) {
                    continue;
                  }
                  for (const key of keys) {
                    const watched = subscriptions.get(connId)?.get(key);
                    if (!watched || watched.target.identity !== state.target.identity) {
                      continue;
                    }
                    try {
                      watched.target.assertCurrent?.();
                      return;
                    } catch {
                      // A different watcher may still own a current grant.
                    }
                  }
                }
                throw new Error("Session pull-request watchers changed");
              };
              assertReadCurrent();
              let assertReadAuthority: (() => void) | undefined;
              const snapshot = await loadSessionPullRequests(
                { ...state.target.params, ...(refresh ? { refresh: true } : {}) },
                state.cacheLifetime.signal,
                {
                  target: selectedRead ? { ...state.target, read: selectedRead } : state.target,
                  sourceIdentity,
                  sourceScope,
                  readTaskPublications: readTaskPublicationsForState(state),
                  branchSnapshot: state.branchSnapshot,
                  onBranchRead: (branch) => {
                    assertReadCurrent();
                    prepared.publishBranchSnapshot(state.target, pushedSnapshot(branch));
                  },
                  assertCurrent: assertReadCurrent,
                  retainReadAuthority: (guard) => {
                    assertReadAuthority = guard;
                  },
                },
              )
                .then(pushedSnapshot)
                .catch(() => ({ ...UNAVAILABLE_SNAPSHOT }));
              if ((await currentKeyState(cacheKey)) === state) {
                assertSourceCurrent();
                prepared.publishSnapshot(state, snapshot, assertReadAuthority);
                // Shared equality does not acknowledge recipients that missed publication.
                await push(new Set(state.connIds), state, snapshot, assertSourceCurrent, refresh);
              }
              return snapshot;
            });
          })
          .catch(() => UNAVAILABLE_SNAPSHOT)
          .finally(() => {
            if (inflight.get(cacheKey)?.promise === promise) {
              inflight.delete(cacheKey);
            }
          });
        inflight.set(cacheKey, {
          promise,
          refresh,
          state,
        });
        return promise;
      },
    ).catch(() => UNAVAILABLE_SNAPSHOT);
  };

  const push = (
    connIds: ReadonlySet<string>,
    state: WatchedKeyState,
    snapshot: ControlUiSessionPullRequestSnapshot,
    assertSourceCurrent: () => void,
    refresh = false,
    requestedKey?: string,
  ): Promise<void> => {
    if (connIds.size === 0 || (state.target.ownGitHubProfileId && state.snapshot !== snapshot)) {
      return Promise.resolve();
    }
    // Retain the authority for these facts across queued delivery and watcher reads.
    const assertReadAuthority = state.assertReadAuthority;
    const hash = JSON.stringify(snapshot);
    const isDelivered = (watched: Watched) =>
      !(refresh && watched.refreshPending) && watched.deliveredHash === hash;
    return enqueuePrDelivery(state, async () => {
      for (const connId of connIds) {
        const keys = requestedKey
          ? [requestedKey]
          : [...(state.sessionKeysByConnId.get(connId) ?? [])];
        for (const sessionKey of keys) {
          const watched = subscriptions.get(connId)?.get(sessionKey);
          if (!watched || isDelivered(watched)) {
            continue;
          }
          const current = await currentWatcher(connId, sessionKey);
          if (
            !current ||
            scope.isClosing ||
            current.watched !== watched ||
            current.target.identity !== state.target.identity ||
            subscriptions.get(connId)?.get(sessionKey) !== watched ||
            !deps.reads.isViewerConnected(connId) ||
            keyStates.get(state.target.identity) !== state ||
            isDelivered(watched)
          ) {
            continue;
          }
          assertSourceCurrent();
          try {
            // The shared cache can carry another viewer's target after preparation yields.
            current.target.assertCurrent?.();
            assertReadAuthority?.();
          } catch {
            if (current.target.ownGitHubProfileId) {
              if (state.snapshot === snapshot) {
                state.snapshot = undefined;
              }
              deps.reads.invalidateViewer(connId);
            }
            // Losing one recipient must not suppress the same snapshot for other viewers.
            continue;
          }
          const sessions = Object.create(null) as ControlUiSessionPullRequestsChanged["sessions"];
          sessions[sessionKey] = snapshot;
          // A socket callback can replace the session or retire another viewer synchronously.
          deps.reads.publishReviewUpdates(new Set([connId]), { sessions }, state.target.params);

          if (subscriptions.get(connId)?.get(sessionKey) === watched) {
            watched.deliveredHash = hash;
            if (refresh) {
              delete watched.refreshPending;
            }
          }
        }
      }
    });
  };

  const schedulePoll = () => {
    if (scope.isClosing || pollJob || subscriptions.size === 0) {
      return;
    }
    pollJob = scheduler.schedule({
      id: "control-ui-session-pr-poll",
      atMs: scheduler.now() + CONTROL_UI_SESSION_PR_POLL_INTERVAL_MS,
      everyMs: CONTROL_UI_SESSION_PR_POLL_INTERVAL_MS,
      run: pollNow,
    });
  };

  const pollNow = (): Promise<void> => {
    if (scope.isClosing) {
      return Promise.resolve();
    }
    return scope.track(async () => {
      // One union pass owns each key once; the loader retains its failure and
      // rate-limit cache, so the poller never creates a second quota policy.
      const loads = [];
      for (const [sessionKey, state] of keyStates) {
        if (state.connIds.size > 0) {
          loads.push(
            state.target.taskReceiptsOnly ? currentKeyState(sessionKey) : loadSnapshot(sessionKey),
          );
        }
      }
      await Promise.all([Promise.allSettled(replacements), prepared.settle(), ...loads]);
      // Revalidation can migrate an audience to a new cell during this pass.
      await Promise.allSettled(replacements);
    });
  };

  const stopLineage = deps.reads.subscribeChanges((change) => {
    const ownAuthorityChanged = change.kind === "config";
    if (!ownAuthorityChanged && (change.kind !== "session" || !change.lineageChanged)) {
      return;
    }
    // Reconcile only indexed audiences; removed roots wait for their replacement's receipt.
    for (const [key, state] of keyStates) {
      if (ownAuthorityChanged && !state.target.ownGitHubProfileId) {
        continue;
      }
      const removedRoot =
        change.kind === "session" &&
        change.removed &&
        change.sessionKey === state.target.params.sessionKey;
      if (
        !removedRoot &&
        (state.target.includesTaskPublications || state.target.ownGitHubProfileId) &&
        state.connIds.size
      ) {
        void scope.track(() => currentKeyState(key)).catch(() => {});
      }
    }
  });

  const stopReceipts = deps.reads.subscribeChanges((change) => {
    if (change.kind !== "publications") {
      return;
    }
    for (const [key, state] of keyStates) {
      if (!state.target.includesTaskPublications) {
        continue;
      }
      state.snapshot = undefined;
      if (state.prepared) {
        deps.reads.invalidate(state.target.params);
      }
      if (state.connIds.size) {
        void scope
          .track(async () => {
            await inflight.get(key)?.promise;
            await loadSnapshot(key);
          })
          .catch(() => {});
      }
    }
  });

  const replace = (
    connId: string,
    sessionKeys: readonly string[],
    refreshSessionKeys: ReadonlySet<string> = new Set(),
    onAdmitted?: () => void,
    passiveSessionKeys: ReadonlySet<string> = new Set(),
  ) => {
    const activeKeys = new Set(sessionKeys);
    const watchedKeys = [
      ...activeKeys,
      ...[...passiveSessionKeys].filter((key) => !activeKeys.has(key)),
    ];
    let admitted = false;
    const admit = () => {
      if (!admitted) {
        admitted = true;
        onAdmitted?.();
      }
    };
    if (scope.isClosing) {
      admit();
      return Promise.resolve();
    }
    const normalizedConnId = connId.trim();
    if (!normalizedConnId || !deps.reads.isViewerConnected(normalizedConnId)) {
      unsubscribe(normalizedConnId);
      admit();
      return Promise.resolve();
    }
    const generation = {};
    replacementGenerations.set(normalizedConnId, generation);
    for (const key of watchedKeys) {
      const watched = subscriptions.get(normalizedConnId)?.get(key);
      if (watched && refreshSessionKeys.has(key)) {
        watched.refreshPending = true;
      }
    }
    const isCurrentReplacement = () =>
      !scope.isClosing && replacementGenerations.get(normalizedConnId) === generation;
    const replacement = scope.track(async () => {
      try {
        const previousSubscription = subscriptions.get(normalizedConnId);
        const subscription = new Map<string, Watched>();
        for (const key of watchedKeys) {
          const parsed = parseAgentSessionKey(key);
          const session =
            parsed?.rest === "global"
              ? { sessionKey: "global", agentId: parsed.agentId }
              : { sessionKey: key };
          const previous = previousSubscription?.get(key);
          const receiptOnly = !activeKeys.has(key);
          const existingMode = previous?.target.taskReceiptsOnly === true;
          let readCurrent = existingMode === receiptOnly ? previous?.readCurrent : undefined;
          let target = await readCurrent?.();
          if (!target) {
            const preparedRead = createControlUiSessionPrRead(
              deps.reads.createViewerRead(normalizedConnId, {
                ...session,
                allowOwnImportedPullRequest: true,
              }),
              deps.getConfig,
            );
            readCurrent =
              preparedRead && receiptOnly
                ? async () => {
                    const current = await preparedRead();
                    return (
                      current && {
                        ...current,
                        taskReceiptsOnly: true,
                        identity: JSON.stringify([current.identity, "receipts-only"]),
                      }
                    );
                  }
                : preparedRead;
            target = await readCurrent?.();
          }
          if (!readCurrent || !target) {
            continue;
          }
          const next =
            previous?.target.identity === target.identity && readCurrent === previous.readCurrent
              ? previous
              : { readCurrent, target };
          if (next !== previous && refreshSessionKeys.has(key)) {
            next.refreshPending = true;
          }
          subscription.set(key, next);
        }
        const currentReplacement = isCurrentReplacement();
        if (!currentReplacement) {
          const current = subscriptions.get(normalizedConnId);
          for (const [key, watched] of subscription) {
            if (
              !refreshSessionKeys.has(key) ||
              current?.get(key) !== watched ||
              !watched.refreshPending
            ) {
              subscription.delete(key);
            }
          }
        }
        if (subscription.size === 0) {
          if (currentReplacement) {
            unsubscribe(normalizedConnId);
          }
          admit();
          return;
        }
        if (currentReplacement) {
          subscriptions.set(normalizedConnId, subscription);
          // Add before removing so an alias change retains its audience cell and cache lifetime.
          for (const [key, watched] of subscription) {
            const previous = previousSubscription?.get(key);
            const retained = previous && keyStates.get(previous.target.identity);
            addControlUiSessionPrMembership(
              stateForTarget(watched.target, undefined, retained),
              normalizedConnId,
              key,
            );
          }
          removeMemberships(normalizedConnId, previousSubscription, subscription);
          schedulePoll();
        }
        admit();

        await Promise.all(
          Array.from(subscription, async ([sessionKey, watched]) => {
            const cacheKey = watched.target.identity;
            const targetState = await currentKeyState(cacheKey);
            if (!targetState) {
              return;
            }
            return withSource(targetState.target, async (assertSourceCurrent, sourceIdentity) => {
              const state = stateForTarget(targetState.target, sourceIdentity);
              const isCurrent = () =>
                subscriptions.get(normalizedConnId)?.get(sessionKey) === watched;
              const refresh = refreshSessionKeys.has(sessionKey);
              const cached = refresh ? undefined : state.snapshot;
              // A shared cached snapshot does not prove this connection received it.
              if (cached) {
                if (!watched.deliveredHash) {
                  await push(
                    new Set([normalizedConnId]),
                    state,
                    cached,
                    assertSourceCurrent,
                    false,
                    sessionKey,
                  );
                }
                return;
              }
              const snapshot = await loadSnapshot(cacheKey, refresh);
              assertSourceCurrent();
              // A removed/re-added key has a new cell; retained keys still need their result.
              if (isCurrent() && (refresh ? watched.refreshPending : !watched.deliveredHash)) {
                await push(
                  new Set([normalizedConnId]),
                  state,
                  snapshot,
                  assertSourceCurrent,
                  refresh,
                  sessionKey,
                );
              }
            }).catch(() => {});
          }),
        );
      } finally {
        admit();
      }
    });
    replacements.add(replacement);
    const releaseReplacement = () => {
      replacements.delete(replacement);
      if (replacementGenerations.get(normalizedConnId) === generation) {
        replacementGenerations.delete(normalizedConnId);
      }
    };
    void replacement.then(releaseReplacement, releaseReplacement);
    return replacement;
  };

  const unsubscribe = (connId: string) => {
    const normalizedConnId = connId.trim();
    if (!normalizedConnId) {
      return;
    }
    replacementGenerations.delete(normalizedConnId);
    removeMemberships(normalizedConnId, subscriptions.get(normalizedConnId));
    subscriptions.delete(normalizedConnId);
    if (subscriptions.size === 0) {
      pollJob?.cancel();
      pollJob = undefined;
    }
  };

  const stop = (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }
    scope.beginClose();
    scheduler.beginClose();
    prepared.stop();
    stopReceipts();
    stopLineage();
    subscriptions.clear();
    replacementGenerations.clear();
    replacements.clear();
    for (const state of keyStates.values()) {
      state.cancelRefresh?.();
      state.cacheLifetime.abort(null);
    }
    keyStates.clear();
    stopPromise = Promise.all([scope.drain(), scheduler.stop()]).then(() => {
      inflight.clear();
    });
    return stopPromise;
  };

  return {
    read: prepared.read,
    readPrepared: prepared.readPrepared,
    replace,
    unsubscribe,
    pollNow,
    stop,
  };
}

/** An older delivery must not overtake its replacement for the same watched source. */
function enqueuePrDelivery(
  owner: { delivery?: Promise<void> },
  deliver: () => Promise<void>,
): Promise<void> {
  const delivery = (owner.delivery ?? Promise.resolve()).then(deliver).finally(() => {
    if (owner.delivery === delivery) {
      delete owner.delivery;
    }
  });
  owner.delivery = delivery;
  return delivery;
}
