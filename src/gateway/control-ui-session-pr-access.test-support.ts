import { expect, vi } from "vitest";
import { repositorySessionPrTarget } from "../../extensions/github-repositories/control-ui-session-pr-read-api.js";
import repositoryPlugin from "../../extensions/github-repositories/index.js";
import repositoryManifest from "../../extensions/github-repositories/openclaw.plugin.json" with { type: "json" };
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { deleteSessionEntryLifecycle } from "../config/sessions.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { setActivePluginRegistry, resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { startPluginServices } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { ControlUiSessionPullRequests } from "./control-ui-contract.js";
import {
  spyOnSessionPrLoader,
  type SessionPrLoader,
} from "./control-ui-session-pr-subscriptions.test-support.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import type { OperatorScope } from "./operator-scopes.js";
import { createRepositorySessionReadHost } from "./repository-session-read-host.js";
import { createRepositorySources } from "./repository-sources.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { createGatewayWsTestSocket } from "./server/ws-connection.test-helpers.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils-store.js";

const METHOD = "controlUi.sessionPullRequests.subscribe";
export const sessionKey = "agent:main:guest-publication";
export const branch = { owner: "synthetic", repo: "publication", branch: "guest-change" };
export const snapshot: ControlUiSessionPullRequests = {
  pullRequests: [],
  branch,
  rateLimited: false,
};
export const readerChanges = [
  "unchanged",
  "role",
  "connection",
  "profile",
  "visibility",
  "grant",
  "replacement grant",
] as const;
export type Load = SessionPrLoader;

function authority(access = new AbortController()) {
  return { signal: access.signal, assertCurrent: () => access.signal.throwIfAborted() };
}

let fixtureSequence = 0;

export async function createFixture(
  scope: OperatorScope,
  useDefaultLoader = false,
  initialSessionPatch: Partial<SessionEntry> = {},
) {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const fixtureId = ++fixtureSequence;
  const readerEmail = `guest-publication-reader-${fixtureId}@example.test`;
  const profile = ensureProfileForEmail(readerEmail);
  const other = ensureProfileForEmail(`publication-owner-${fixtureId}@example.test`);
  const seeded = new Set<string>();
  const sessionId = `${sessionKey}-${fixtureId}`;
  const readerRole = { agents: ["main"], sessions: { others: "view" as const }, scopes: [scope] };
  const cfg: OpenClawConfig = {
    gateway: { roles: { default: "reader", definitions: { reader: readerRole } } },
  };
  setUserProfileRole(profile.id, "reader");
  setRuntimeConfigSnapshot(cfg);
  const pluginFixture = createPluginRegistryFixture(cfg);
  registerTestPlugin({
    ...pluginFixture,
    record: createPluginRecord({
      id: "github-repositories",
      name: "GitHub repositories",
      repositorySources: repositoryManifest.repositorySources,
    }),
    register: repositoryPlugin.register,
  });
  setActivePluginRegistry(pluginFixture.registry.registry);
  const seed = async (key: string, creator = profile.id, patch: Partial<SessionEntry> = {}) => {
    if (!seeded.has(key)) {
      expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey: key })).toBeUndefined();
      seeded.add(key);
    }
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: key },
      {
        sessionId: `${key}-${fixtureId}`,
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: creator },
        spawnedCwd: "/synthetic/guest-publication",
        ...patch,
      },
    );
  };
  await seed(sessionKey, profile.id, initialSessionPatch);
  const connections = createGatewayConnectionState({
    scheduler,
    bootId: "publication-read",
    cfg,
    getRuntimeConfig,
  });
  const addReader = (connId: string) => {
    const socket = createGatewayWsTestSocket();
    const client = createOperatorWsClient({ connId, socket, scopes: [scope] });
    const access = new AbortController();
    client.internal = {
      ...client.internal,
      operatorAccessAuthority: authority(access),
    };
    client.authenticatedUserProfile = {
      profileId: profile.id,
      avatarRevision: "fixture",
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    };
    prepareGatewayRecipientProfile(client);
    connections.clients.add(client);
    return { client, socket, access };
  };
  const load = vi.fn<Load>(async () => snapshot);
  if (!useDefaultLoader) {
    spyOnSessionPrLoader(load);
  }
  const contextParams = makeContextParams(connections);
  const context = createGatewayRequestContext(contextParams);
  context.getRuntimeConfig = getRuntimeConfig;
  const resolveGatewayContext = () => context;
  context.resolveGatewayContext = resolveGatewayContext;
  context.repositorySources = createRepositorySources(
    scheduler.signal,
    pluginFixture.registry.registry,
  );
  const readHost = createRepositorySessionReadHost({
    signal: scheduler.signal,
    getRuntimeConfig,
    getSessionRowProjection: () => getSessionRowProjection(context),
    getClient: (connId) => connections.clients.getByConnectionId(connId),
    resolveGatewayContext,
    broadcastToConnIds: connections.broadcastToConnIds,
  });
  contextParams.runtime.runtimeState.repositorySessions = readHost;
  const binding = vi.spyOn(readHost, "bindService");
  const services = await withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
    startPluginServices({ scheduler, registry: pluginFixture.registry.registry, config: cfg }),
  );
  const selectedBinding = binding.mock.results.find((result) => result.type === "return");
  binding.mockRestore();
  if (!selectedBinding || selectedBinding.type !== "return" || !readHost.presentation) {
    await services.stop();
    throw new Error("The actual GitHub presentation service did not start");
  }
  const reads = selectedBinding.value;
  const presentation = readHost.presentation;
  const subscriptions = {
    ...presentation,
    readPrepared: (
      target:
        | Parameters<typeof repositorySessionPrTarget>[0]
        | ReturnType<typeof repositorySessionPrTarget>,
      admitLoad?: () => boolean,
    ) =>
      presentation.readPrepared("observation" in target ? target.observation : target, admitLoad),
  };
  await initializeSessionReadContext(context);
  const reader = addReader("guest-publication-reader");
  const projection = getSessionRowProjection(context);
  if (!projection) {
    throw new Error("Missing fixture session projection");
  }
  const detachProjection = connections.attachSessionRowProjection(projection);
  return {
    ...reader,
    clock,
    addReader,
    profile,
    readerEmail,
    other,
    sessionId,
    cfg,
    seed,
    load,
    subscriptions,
    sessionReads: reads,
    presentation,
    readHost,
    services,
    context,
    async changeReader(change: (typeof readerChanges)[number], key = sessionKey) {
      if (change === "role") {
        const revoked = structuredClone(cfg);
        revoked.gateway!.roles!.definitions!.reader!.scopes = [];
        setRuntimeConfigSnapshot(revoked);
      } else if (change === "connection") {
        reader.client.invalidated = true;
      } else if (change === "profile") {
        linkEmail(readerEmail, other.id);
      } else if (change === "visibility") {
        await seed(key, other.id, { visibility: "draft", updatedAt: 2 });
      } else if (change === "grant") {
        reader.access.abort(new Error("Original access retired"));
      } else if (change === "replacement grant") {
        reader.client.internal = {
          ...reader.client.internal,
          operatorAccessAuthority: authority(),
        };
      }
    },
    async seedRepository(
      key = sessionKey,
      repo = "publication",
      patch: Partial<SessionEntry> = {},
      repoBranch = "guest-change",
    ) {
      const repository = await getSessionRepositoryWorkspaceStore().create({
        agentId: "main",
        sessionKey: key,
        url: `https://github.com/synthetic/${repo}`,
        branch: repoBranch,
        assertCurrent: () => {},
      });
      await seed(key, profile.id, { ...patch, repositoryWorkspaceId: repository.workspaceId });
      return repository;
    },
    async subscribe(keys = [sessionKey], client = reader.client) {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: "watch", method: METHOD, params: { sessionKeys: keys } },
        client,
        context,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledWith(true, { subscribed: keys.length > 0 }, undefined);
    },
    async close() {
      await services.stop();
      await scheduler.stop();
      connections.clients.clear();
      detachProjection();
      await disposeSessionReadContexts();
      resetPluginRuntimeStateForTest();
    },
    async removeSessions() {
      for (const key of seeded) {
        const original = loadSessionEntryReadOnly({ agentId: "main", sessionKey: key });
        if (original) {
          await deleteSessionEntryLifecycle({
            agentId: "main",
            storePath: (await loadGatewaySessionEntryReadOnlyAsync(key, { agentId: "main" }))
              .storePath,
            target: { canonicalKey: key, storeKeys: [key] },
            expectedSessionId: original.sessionId,
            archiveTranscript: false,
          });
        }
      }
    },
  };
}
