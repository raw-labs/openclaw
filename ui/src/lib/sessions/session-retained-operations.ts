import type {
  ControlUiSessionOperationFactory,
  ControlUiSessionOperationBinding,
} from "../../../../src/plugin-sdk/control-ui-session-operation.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { isGatewayMethodAdvertised } from "../gateway-methods.ts";
import {
  readSessionChangedEvent,
  reconcileSessionChanged,
  reconcileSessionHistory,
} from "./reconcile.ts";
import type { createSessionDeletions } from "./session-deletions.ts";
import { isUiGlobalSessionKey, resolveUiConversationIdentity } from "./session-key.ts";
import type { SessionConnectionOwner, SessionGateway } from "./session-types.ts";

const MAX_RETAINED_OPERATIONS = 32;

type Host = {
  connection: SessionConnectionOwner;
  snapshot: () => SessionGateway["snapshot"];
  deletionState: (
    row: GatewaySessionRow,
  ) => ReturnType<ReturnType<typeof createSessionDeletions>["deletionState"]>;
};

function invocationRow(row: GatewaySessionRow): GatewaySessionRow {
  return {
    key: row.key,
    agentId: row.agentId,
    kind: row.kind,
    updatedAt: row.updatedAt,
    sessionId: row.sessionId,
    sharingRole: row.sharingRole,
    visibility: row.visibility,
    archived: row.archived,
    worktree: row.worktree,
    repositoryWorkspaceId: row.repositoryWorkspaceId,
    repository: row.repository,
  };
}

function authority(row: GatewaySessionRow): string {
  const workspace = row.repositoryWorkspaceId
    ? ["repository", row.repositoryWorkspaceId, row.repository?.branch]
    : ["worktree", row.worktree?.id, row.worktree?.branch, row.worktree?.repoRoot];
  return JSON.stringify([
    row.sessionId,
    row.sharingRole,
    row.visibility,
    row.archived === true,
    ...workspace,
  ]);
}
function identity(snapshot: SessionGateway["snapshot"], methods: readonly string[]): string {
  return JSON.stringify([
    snapshot.selfUser?.identity ?? null,
    snapshot.hello?.auth?.role,
    snapshot.hello?.auth?.scopes,
    methods.map((method) => isGatewayMethodAdvertised(snapshot, method)),
  ]);
}

/** Admitted operations outlive panes; acknowledgement, rejection or authority retirement releases them. */
export function createSessionRetainedOperations(host: Host) {
  const entries = new Map<string, Entry>();
  type Entry = {
    row: GatewaySessionRow;
    retained: boolean;
    operation: unknown;
    routeKey: string;
    reset: () => void;
    hasBindings: () => boolean;
    invalidate: () => void;
    observeEvent: (event: string, payload: unknown) => void;
    current: () => boolean;
  };
  const keyFor = (row: Pick<GatewaySessionRow, "key" | "agentId">, agentId?: string | null) => {
    const owner = resolveUiConversationIdentity(host.snapshot(), row.key, row.agentId ?? agentId);
    return `${owner.agentId ?? ""}\0${owner.sessionKey}`;
  };
  const retire = (key: string, entry: Entry) => {
    entries.delete(key);
    entry.reset();
  };
  const releaseIdle = (key: string, entry: Entry) => {
    if (!entry.retained && !entry.hasBindings() && entries.get(key) === entry) {
      entries.delete(key);
    }
  };
  const reconcile = (
    apply: (row: GatewaySessionRow, key: string) => GatewaySessionRow | undefined,
  ) => {
    for (const [key, entry] of entries) {
      const next = apply(entry.row, entry.routeKey);
      if (!entry.current() || !next || authority(next) !== authority(entry.row)) {
        retire(key, entry);
      } else {
        entry.row = invocationRow(next);
      }
    }
  };
  const snapshotFor = (row: GatewaySessionRow): SessionsListResult => ({
    ts: 0,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [row],
  });
  return {
    attach<TBinding extends object>(
      row: GatewaySessionRow,
      factory: ControlUiSessionOperationFactory<TBinding>,
      pluginId: string,
    ): ControlUiSessionOperationBinding<TBinding> | null {
      const connection = host.connection.capture();
      if (
        !connection ||
        factory.requiredMethods.some(
          (method) => isGatewayMethodAdvertised(host.snapshot(), method) !== true,
        )
      ) {
        return null;
      }
      const route = resolveUiConversationIdentity(host.snapshot(), row.key, row.agentId);
      const routeKey = `${route.agentId ?? ""}\0${route.sessionKey}`;
      const key = `${pluginId}\0${factory.id}\0${routeKey}`;
      const owner = identity(host.snapshot(), factory.requiredMethods);
      let entry = entries.get(key);
      if (
        entry &&
        (!entry.current() ||
          authority(entry.row) !== authority(row) ||
          !factory.isOperation(entry.operation))
      ) {
        retire(key, entry);
        entry = undefined;
      }
      if (!entry) {
        const candidate: Entry = {
          // Keep only invocation/authority facts, never a transcript or pane state.
          row: invocationRow({ ...row, key: route.sessionKey, agentId: route.agentId }),
          retained: false,
          routeKey,
          operation: undefined,
          reset: () => operation.reset(),
          hasBindings: () => operation.hasBindings,
          invalidate: () => operation.invalidate(),
          observeEvent: (event, payload) => operation.observeEvent?.(event, payload, candidate.row),
          // Pending deletion can roll back; matches() fences actions without
          // discarding custody before the deletion owner confirms retirement.
          current: () =>
            entries.get(key) === candidate &&
            host.connection.isCurrent(connection) &&
            identity(host.snapshot(), factory.requiredMethods) === owner &&
            host.deletionState(candidate.row) !== "confirmed",
        };
        const operation = factory.create({
          client: {
            request: async <T>(method: string, params?: Record<string, unknown>) => {
              if (!candidate.current()) {
                throw new Error("This session operation has ended.");
              }
              const result = await connection.client.request<T>(method, params);
              if (!candidate.current()) {
                throw new Error("This session operation has ended.");
              }
              return result;
            },
          },
          target: route,
          isCurrent: () => candidate.current(),
          reserve: () => {
            if (!candidate.current()) {
              throw new Error("This session operation has ended.");
            }
            if (candidate.retained) {
              return;
            }
            if (
              [...entries.values()].filter((retainedEntry) => retainedEntry.retained).length >=
              MAX_RETAINED_OPERATIONS
            ) {
              throw factory.capacityError();
            }
            candidate.retained = true;
          },
          release: () => {
            candidate.retained = false;
            releaseIdle(key, candidate);
          },
          unbound: () => releaseIdle(key, candidate),
        });
        candidate.operation = operation;
        entry = candidate;
        // Split panes share idle state too; only admitted operations survive the last detach.
        entries.set(key, entry);
      }
      const operation = entry;
      if (!factory.isOperation(operation.operation)) {
        return null;
      }
      return Object.assign(operation.operation.bind(), {
        matches: (next: GatewaySessionRow) =>
          operation.current() &&
          !host.deletionState(next) &&
          keyFor(next) === operation.routeKey &&
          authority(next) === authority(operation.row),
      });
    },
    observeRows(rows: readonly GatewaySessionRow[], agentId?: string | null) {
      if (entries.size === 0) {
        return;
      }
      const incoming = new Map(rows.map((row) => [keyFor(row, agentId), row]));
      reconcile((row, key) => {
        const next = incoming.get(key);
        return next
          ? reconcileSessionHistory(
              snapshotFor(row),
              { ...next, key: row.key, agentId: row.agentId },
              undefined,
              { archivedFilter: "all", selectedGlobalAgentId: row.agentId },
            )?.sessions[0]
          : row;
      });
    },
    observeEvent(payload: unknown) {
      if (entries.size === 0) {
        return;
      }
      const event = readSessionChangedEvent(payload);
      // Global events without an agent cannot identify which admitted operation they affect.
      if (!event || (isUiGlobalSessionKey(event.key) && !event.agentId)) {
        return;
      }
      const key = keyFor({ key: event.key }, event.agentId);
      reconcile((row, retainedKey) =>
        retainedKey === key
          ? reconcileSessionChanged(snapshotFor(row), payload, {
              archivedFilter: "all",
              selectedGlobalAgentId: row.agentId,
            }).result?.sessions[0]
          : row,
      );
      for (const entry of entries.values()) {
        if (entry.current() && entry.routeKey === key) {
          entry.observeEvent("sessions.changed", payload);
        }
      }
    },
    observePayload(event: string, payload: unknown) {
      for (const entry of entries.values()) {
        if (entry.current()) {
          entry.observeEvent(event, payload);
        }
      }
    },
    invalidate() {
      for (const entry of entries.values()) {
        if (entry.current()) {
          entry.invalidate();
        }
      }
    },
    clear() {
      for (const [key, entry] of entries) {
        retire(key, entry);
      }
    },
  };
}
