import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bindOperatorModelExecution } from "../agents/admitted-run-context.js";
import {
  readHarnessSessionWorkSource,
  type HarnessSessionWorkWorkspace,
} from "../agents/harness/host-session-work-source.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { captureAmbientGatewayOperatorAuthority } from "../gateway/operator-invocation-authority.js";
import type { OperatorRunRecoverySnapshot } from "../gateway/operator-run-recovery-source.codec.js";
import { restoreGatewayOperatorSource } from "../gateway/operator-run-recovery.js";
import { runWithOperatorToolGatewayAuthority } from "../gateway/operator-tool-gateway-authority.js";
import { runWithPluginSessionWorkAuthority } from "../gateway/plugin-session-work-authority.js";
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { resolveInProcessGatewayDispatch } from "../gateway/server-plugin-in-process-authority.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import {
  prepareGatewaySessionAccessAuthority,
  SessionAccessPreparationPendingError,
} from "../gateway/session-access-authority.js";
import { SessionMutationAuthorizationChangedError } from "../gateway/session-mutation-authorization-error.js";
import { requireSessionRowProjection } from "../gateway/session-row-projection-access.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import { createCorePluginStateKeyedStoreV2 } from "../plugin-state/plugin-state-store.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import type { PluginRegistry } from "./registry-types.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { openSessionWorkAssistantPreview } from "./service-session-work-preview.js";
import type {
  PluginServiceRecoveredSessionWorkContextV1,
  PluginServiceSessionWorkContextV1,
  PluginServiceSessionWorkV1,
} from "./service-session-work.types.js";

type AcceptedWork = {
  target: PluginServiceSessionWorkContextV1["target"];
  toolName?: string;
  tools: string[];
  snapshot?: OperatorRunRecoverySnapshot;
  workspace?: HarnessSessionWorkWorkspace;
};
class SessionWorkAuthorizationError extends Error {}

const retentionMs = 7 * 24 * 60 * 60_000;

/** Host custody and current policy, separate from feature-owned jobs, wakes and results. */
export function createPluginServiceSessionWork(params: {
  pluginId: string;
  serviceId: string;
  registry: PluginRegistry;
  lease: PluginRuntimeCapabilityLease;
  signal: AbortSignal;
  isStopping: () => boolean;
  resolveGatewayContext?: GatewayContextResolver;
}): PluginServiceSessionWorkV1 & Required<Pick<PluginServiceSessionWorkV1, "admitTurn">> {
  const assertService = () => {
    params.lease.assertActive("session work");
    params.signal.throwIfAborted();
    if (params.isStopping()) {
      throw new Error("Plugin service session work is stopping");
    }
  };
  const namespace = createHash("sha256")
    .update(JSON.stringify([params.pluginId, params.serviceId]))
    .digest("hex");
  const store = (assertCurrent = assertService) =>
    createCorePluginStateKeyedStoreV2<AcceptedWork>(
      {
        ownerId: "core:plugin-session-work",
        namespace,
        maxEntries: 4096,
        overflowPolicy: "reject-new",
      },
      { assertCurrent },
    );
  const context = () => {
    assertService();
    const current = params.resolveGatewayContext?.();
    if (!current) {
      throw new Error("Session work requires its current Gateway");
    }
    return current;
  };
  const validateId = (id: string) => {
    if (!id || id.length > 256) {
      throw new Error("Session work requires a bounded logical operation ID");
    }
  };
  async function withInvocation<T>(
    input: {
      agentId: string;
      sessionKey: string;
      toolName?: string;
      delegatedTools?: readonly string[];
    },
    work: (current: PluginServiceSessionWorkContextV1, record: AcceptedWork) => Promise<T>,
    harness?: { sessionId: string; workspace?: HarnessSessionWorkWorkspace },
  ): Promise<T> {
    const owner = context();
    const scope = getPluginRuntimeGatewayRequestScope();
    if (!harness) {
      const toolName = input.toolName;
      if (
        !toolName ||
        scope?.pluginId !== params.pluginId ||
        !params.registry.tools.some(
          (entry) =>
            entry.pluginId === params.pluginId &&
            (entry.declaredNames?.has(toolName) ?? entry.names.includes(toolName)),
        )
      ) {
        throw new Error("Session work requires its registered tool owner");
      }
    }
    const caller = getGatewayToolCallerIdentity();
    const assertCaller = captureGatewayToolCallerAssertion();
    if (caller && (caller.agentId !== input.agentId || caller.sessionKey !== input.sessionKey)) {
      throw new Error("Session work must target the invoking agent's own conversation");
    }
    const captured = await captureAmbientGatewayOperatorAuthority({
      missingBindingError: () => new Error("Session work requires its original operator source"),
      retainInherited: true,
    });
    const active = new AbortController();
    const signal = AbortSignal.any([
      params.signal,
      active.signal,
      ...(scope?.signal ? [scope.signal] : []),
      ...(captured.authority?.signal ? [captured.authority.signal] : []),
    ]);
    let releaseSession: (() => void) | undefined;
    let assertSession: (() => void) | undefined;
    try {
      const assertCurrent = () => {
        signal.throwIfAborted();
        assertService();
        if (context() !== owner) {
          throw new Error("Session work Gateway changed");
        }
        assertCaller?.();
        captured.assertInvocationCurrent?.();
        captured.authority?.assertCurrent();
        assertSession?.();
      };
      assertCurrent();
      const resolved = resolveInProcessGatewayDispatch("tools.invoke", input, {
        // A spawned opening can still carry the parent's transport caller.
        // Bind admitted work to the current run and retain the original operator's scopes.
        ...(caller?.operationalRunInstance
          ? { forceSyntheticClient: true, syntheticScopeMode: "exact" }
          : {}),
        pluginRuntimeOwnerId: params.pluginId,
        resolveGatewayContext: params.resolveGatewayContext,
      });
      const tools = [...new Set(input.delegatedTools ?? [])];
      if (input.toolName && !tools.includes(input.toolName)) {
        tools.unshift(input.toolName);
      }
      if (tools.length > 256 || tools.some((name) => !name || name.length > 256)) {
        throw new Error("Session work tool request exceeds its bound");
      }
      let target: AcceptedWork["target"] | undefined;
      // Admit the conversation and the current executable ceiling together.
      const names = input.toolName ? tools : [undefined];
      for (const name of names) {
        if (name) {
          if (caller?.operationalRunInstance && !caller.assertToolAllowed) {
            throw new Error("Session work requires the original executable tool policy");
          }
          caller?.assertToolAllowed?.(name);
        }
        const prepared = await prepareGatewaySessionAccessAuthority({
          policy: { mode: "write", ...(name ? { requiredTool: name } : {}) },
          methodOwner: { kind: "plugin", pluginId: params.pluginId },
          pluginRegistry: params.registry,
          requestParams: input,
          client: resolved.operatorSourceClient,
          context: owner,
          ownSessionOnly: false,
          assertInvocationCurrent: assertCurrent,
        });
        try {
          assertCurrent();
          prepared.authority.assertCurrent();
          if (name === input.toolName) {
            target = prepared.authority.target;
            const retained = prepared.authority.retain();
            releaseSession = retained.release;
            assertSession = retained.assertCurrent;
          }
        } finally {
          prepared.authority.release();
        }
      }
      if (!target || (harness && harness.sessionId !== target.sessionId)) {
        throw new Error("Session work target was not admitted");
      }
      assertCurrent();
      const record: AcceptedWork = {
        target: Object.freeze({ ...target }),
        ...(input.toolName ? { toolName: input.toolName } : {}),
        tools,
        ...(harness?.workspace ? { workspace: harness.workspace } : {}),
        ...(captured.authority?.recoverySnapshot
          ? { snapshot: captured.authority.recoverySnapshot }
          : {}),
      };
      const value = await work(
        Object.freeze({ target: record.target, signal, assertCurrent }),
        record,
      );
      assertCurrent();
      return value;
    } finally {
      active.abort(new Error("Current session work borrow closed"));
      releaseSession?.();
      captured.release?.();
    }
  }
  async function recordAdmission(id: string, assertCurrent: () => void, record: AcceptedWork) {
    const durable = store(assertCurrent);
    if (!(await durable.registerIfAbsent(id, record, { ttlMs: retentionMs }))) {
      const existing = await durable.lookup(id);
      assertCurrent();
      if (!isDeepStrictEqual(existing, record)) {
        throw new Error("Session work ID belongs to a different accepted operation");
      }
    }
    return { target: record.target, recoverable: record.snapshot !== undefined };
  }
  return {
    version: 1,
    withCurrent: (input, work) => withInvocation(input, (current) => work(current)),
    async admit(input) {
      validateId(input.id);
      return withInvocation(input, async ({ assertCurrent }, record) =>
        recordAdmission(input.id, assertCurrent, record),
      );
    },
    async admitTurn(input) {
      validateId(input.id);
      const source = readHarnessSessionWorkSource(input.source);
      if (source?.pluginId !== params.pluginId) {
        throw new Error("Session work requires this service's admitted harness turn.");
      }
      const toolNames = [...input.toolNames];
      return source.run(toolNames, async () =>
        withInvocation(
          {
            agentId: source.agentId,
            sessionKey: source.sessionKey,
            delegatedTools: toolNames,
          },
          async ({ assertCurrent }, record) =>
            record.snapshot
              ? recordAdmission(input.id, assertCurrent, record)
              : { target: record.target, recoverable: false },
          source,
        ),
      );
    },
    async run(id, work) {
      validateId(id);
      const owner = context();
      const assertOwner = () => {
        assertService();
        if (context() !== owner) {
          throw new Error("Session work Gateway changed");
        }
      };
      const durable = store(assertOwner);
      const accepted = await durable.lookup(id);
      assertOwner();
      if (!accepted?.snapshot) {
        return {
          status: "unavailable",
          reason: "Original source has no restart-recoverable authority",
        };
      }
      const projection = requireSessionRowProjection(owner);
      const readTarget = () => {
        assertOwner();
        if (requireSessionRowProjection(owner) !== projection) {
          throw new Error("Session work projection changed");
        }
        const state = projection.sharingTargetState({
          agentId: accepted.target.agentId,
          key: accepted.target.sessionKey,
        });
        if (state.status === "pending") {
          throw new SessionAccessPreparationPendingError();
        }
        const current = state.status === "ready" ? state.target : undefined;
        if (
          !current ||
          current.entry.sessionId !== accepted.target.sessionId ||
          current.entry.lifecycleRevision !== accepted.target.lifecycleRevision
        ) {
          throw new SessionWorkAuthorizationError(
            "Session work conversation is unavailable or changed",
          );
        }
        return current;
      };
      const assertTarget = () => {
        readTarget();
      };
      let restored: Awaited<ReturnType<typeof restoreGatewayOperatorSource>> | undefined;
      let session: Awaited<ReturnType<typeof prepareGatewaySessionAccessAuthority>> | undefined;
      const active = new AbortController();
      let started = false;
      let assertBorrow = () => {
        assertTarget();
        active.signal.throwIfAborted();
      };
      try {
        restored = await restoreGatewayOperatorSource({
          snapshot: accepted.snapshot,
          target: accepted.target,
          context: owner,
          assertCurrent: assertOwner,
          prepareCurrent: async () => {
            const current = await durable.lookup(id);
            assertOwner();
            await projection.prepareMembership();
            assertTarget();
            if (!isDeepStrictEqual(current, accepted)) {
              throw new SessionWorkAuthorizationError("Accepted source no longer owns this work");
            }
          },
        });
        const authority = restored.authority;
        const signal = AbortSignal.any([
          params.signal,
          active.signal,
          ...(authority.signal ? [authority.signal] : []),
        ]);
        const assertCurrent = () => {
          try {
            signal.throwIfAborted();
            authority.assertCurrent();
            assertBorrow();
          } catch (error) {
            // A transient preparation failure closes this borrow. Catch handlers
            // cannot regain write authority when facts become ready a moment later.
            if (error instanceof SessionAccessPreparationPendingError) {
              active.abort(error);
            }
            throw error;
          }
        };
        const current = Object.freeze<PluginServiceRecoveredSessionWorkContextV1>({
          target: Object.freeze({ ...accepted.target }),
          signal,
          assertCurrent,
          openAssistantPreview: () =>
            openSessionWorkAssistantPreview(accepted.target, assertCurrent),
          async withWorkspaceExecution(request, execute) {
            assertCurrent();
            const { runSessionWorkInWorkspace } =
              await import("./service-session-work-workspace.js");
            assertCurrent();
            const target = readTarget();
            return await runSessionWorkInWorkspace(
              {
                workspace: accepted.workspace,
                target: accepted.target,
                route: request.model,
                prepareNodeWorkspace: request.prepareNodeWorkspace,
                runId: request.runId,
                resolveGatewayContext: owner.resolveGatewayContext,
                storePath: target.storePath,
                pluginId: params.pluginId,
                authority,
                tools: accepted.tools,
                config: owner.getRuntimeConfig(),
                entry: target.entry,
                signal: AbortSignal.any([signal, request.signal]),
                assertCurrent,
              },
              execute,
            );
          },
          async withModelExecution(model, execute) {
            assertCurrent();
            const binding = bindOperatorModelExecution(authority, model);
            if (!binding) {
              throw new Error("Recovered session work requires operator model authority.");
            }
            try {
              return await execute({
                signal: AbortSignal.any([signal, binding.signal]),
                assertCurrent: () => {
                  assertCurrent();
                  binding.assertCurrent();
                },
              });
            } finally {
              binding.release();
            }
          },
        });
        const execution = {
          ...current,
          pluginId: params.pluginId,
          context: owner,
          assertToolAllowed: (name: string) => {
            assertCurrent();
            if (!accepted.tools.includes(name)) {
              throw new Error("Tool was not admitted by this operation's original source");
            }
          },
        };
        const source = {
          authenticatedUserProfile: restored.authenticatedUserProfile,
          scopes: authority.scopes,
          operatorRoleActor: { kind: "operator" as const, profileId: authority.profileId },
          operatorRunAuthority: authority,
          signal,
          assertCurrent,
        };
        session = await runWithPluginSessionWorkAuthority(execution, () =>
          prepareGatewaySessionAccessAuthority({
            policy: {
              mode: "write",
              ...(accepted.toolName ? { requiredTool: accepted.toolName } : {}),
            },
            methodOwner: { kind: "plugin", pluginId: params.pluginId },
            pluginRegistry: params.registry,
            requestParams: accepted.target,
            client: createSyntheticPluginRuntimeClient({
              ...source,
              scopes: [...source.scopes],
              pluginRuntimeOwnerId: params.pluginId,
            }),
            context: owner,
            ownSessionOnly: false,
            assertInvocationCurrent: () => {
              assertTarget();
              authority.assertCurrent();
            },
          }),
        );
        const retained = session.authority.retain();
        session.authority.release();
        session = undefined;
        assertBorrow = () => {
          assertTarget();
          active.signal.throwIfAborted();
          retained.assertCurrent();
        };
        try {
          assertCurrent();
          // Only this borrowed host scope carries the reauthorized source to normal
          // Gateway/model dispatch. No agent run or tool caller is reconstructed.
          started = true;
          const value = await runWithPluginSessionWorkAuthority(execution, () =>
            runWithOperatorToolGatewayAuthority(source, () => work(current)),
          );
          assertCurrent();
          return { status: "completed", value };
        } finally {
          retained.release();
        }
      } catch (error) {
        // Once entered, work may have produced effects. Never advertise whole-callback replay.
        if (started) {
          throw error;
        }
        if (
          error instanceof SessionAccessPreparationPendingError ||
          active.signal.reason instanceof SessionAccessPreparationPendingError
        ) {
          assertOwner();
          return {
            status: "unavailable",
            reason: "Session access is refreshing",
            retryAfterMs: 5000,
          };
        }
        if (
          !(error instanceof SessionMutationAuthorizationChangedError) &&
          !(error instanceof GatewayOperatorRecoveryAuthorizationError) &&
          !(error instanceof SessionWorkAuthorizationError)
        ) {
          throw error;
        }
        assertOwner();
        return {
          status: "unavailable",
          reason: "Original source or current session policy no longer authorizes this operation",
        };
      } finally {
        active.abort(new Error("Session work borrow closed"));
        session?.authority.release();
        restored?.release();
      }
    },
  };
}
