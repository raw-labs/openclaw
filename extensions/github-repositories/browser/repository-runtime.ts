import type { ControlUiHostV2 } from "openclaw/plugin-sdk/control-ui";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createSessionPullRequestStore } from "./session-pull-requests.ts";

/** One activation owns the watched union. Views own interest, not another cache. */
export function createRepositoryBrowserRuntime(
  host: Pick<ControlUiHostV2, "requests" | "signal"> & {
    sessions: Pick<ControlUiHostV2["sessions"], "artifactKey" | "agentId" | "matches">;
  },
) {
  const requests = host.requests;
  const store = createSessionPullRequestStore({
    hasClient: () => requests.capture() !== null,
    canReadAll: () => requests.hasScope("operator.read"),
    // The current native caller admits the owning method with its existing policy.
    canCall: (method, scope) => requests.canCall(method, scope),
    matchesSession: (sessionKey, eventKey, agentId) =>
      host.sessions.matches({ sessionKey }, eventKey, agentId),
    readSessionChanged: (payload) => {
      const event = asNullableRecord(payload);
      const row = asNullableRecord(event?.session);
      const key = row?.key ?? event?.key ?? event?.sessionKey;
      return typeof key === "string"
        ? { key, agentId: typeof event?.agentId === "string" ? event.agentId : undefined }
        : null;
    },
    createConnectionLifecycle: () => {
      let captured = requests.capture();
      return {
        transition() {
          const next = requests.capture();
          const changed = captured ? !captured.isCurrent() : next !== null;
          captured = next;
          return changed;
        },
      };
    },
    createSetSyncLifecycle: requests.createSetSync,
  });
  host.signal.addEventListener("abort", store.dispose, { once: true });
  return {
    store,
    read: (target: { sessionKey: string; agentId?: string }) =>
      store.get(host.sessions.artifactKey(target)),
    observe(target: { sessionKey: string; agentId?: string }, changed: () => void) {
      const owner = {};
      const stop = store.subscribe(changed);
      store.watch(owner, [host.sessions.artifactKey(target)], { foreground: true });
      return () => {
        stop();
        store.unwatch(owner);
      };
    },
  };
}
export type RepositoryBrowserRuntime = ReturnType<typeof createRepositoryBrowserRuntime>;
