// Register native identity and synthetic transport boundaries before the service graph.
// oxfmt-ignore
import {
  createRealPublicationWorkspace,
  createSystemGitHubPublicationRequesterFixture,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistPublicationTestSession,
  publicationRequest,
  SESSION_KEY,
  SESSION_ID,
} from "./github-publication.test-support.js";
import { expect, it, onTestFinished, vi } from "vitest";
import { readRepositoryServices } from "../../extensions/github-repositories/account-runtime-api.js";
import { currentGitHubPublicationConfig } from "../../extensions/github-repositories/publication-availability-api.js";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import { preparePluginToolGatewayCapability } from "../agents/plugin-tool-gateway.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { getActivePluginRegistry, resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginToolFactoryContext } from "../plugins/tool-factory-context.js";
import { bindPluginToolCallbacks } from "../plugins/tool-factory-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { startTestRepositorySessionPresentation } from "./github-account-service.test-support.js";
import {
  createPersonalPublicationFixture,
  personalPublicationRequest,
} from "./github-personal-publication.test-support.js";
import { readGitHubPublicationRequest } from "./github-publication-store.worker.js";
import { readRepositoryGitHubPublicationInDatabase } from "./github-repository-publication-store.worker.js";
import { createRepositoryPublicationFixture } from "./github-repository-publication.test-support.js";
import { createRepositorySessionReadHost } from "./repository-session-read-host.js";
import { createRequestGatewayMethodRegistry, handleGatewayRequest } from "./server-methods.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { loadWorkerPlacementSessionRuntimeModule } from "./server-worker-placement-startup.js";
import { createGatewayWsTestSocket } from "./server/ws-connection.test-helpers.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { createWorkspacePublicationHost } from "./workspace-publication-provider.js";

// Keep the native and SDK command imports on the same synthetic remote transport.
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandBuffered: (
    ...args: Parameters<typeof import("../process/exec.js").runCommandBuffered>
  ) => githubPublicationTestMocks().runCommand(...args),
}));

// Native SQLite, registered service, factory views and local Git are real. GitHub I/O is synthetic.
installGitHubPublicationTestHarness({ realWorktree: true, creatorEmail: "alice@example.test" });
const checkpoint = vi.hoisted(() => vi.fn());
// Repository checkpoint bytes are synthetic; the native registry, receipt and provider execution are real.
vi.mock("./worker-environments/session-repository-checkpoints.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./worker-environments/session-repository-checkpoints.js")
  >()),
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));
const mocks = githubPublicationTestMocks();

async function startPublicationGateway(
  client: GatewayWsClient = {
    ...createSyntheticPluginRuntimeClient({
      operatorRoleActor: { kind: "system" },
      scopes: ["operator.admin"],
    }),
    authenticatedUserProfile: undefined,
    socket: createGatewayWsTestSocket(),
    connId: "publication-service-test",
    usesSharedGatewayAuth: true,
  },
) {
  const params = makeContextParams();
  const scheduler = params.runtime.scheduler;
  const placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
  const host = createWorkspacePublicationHost({
    placements,
    scheduler,
    getCommittedRuntimeConfig: currentGitHubPublicationConfig,
    loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
    managedByPlacement: true,
    warn: () => {},
  });
  params.runtime.workspacePublicationHost = host;
  const context = createGatewayRequestContext(params);
  context.getRuntimeConfig = currentGitHubPublicationConfig;
  context.getCommittedRuntimeConfig = currentGitHubPublicationConfig;
  context.resolveGatewayContext = () => context;
  context.workerSessionPlacementService = placements;
  const methods = createRequestGatewayMethodRegistry();
  context.getGatewayMethodRegistry = () => methods;
  params.runtime.clients.add(client);
  params.runtime.runtimeState.repositorySessions = createRepositorySessionReadHost({
    signal: scheduler.signal,
    getRuntimeConfig: currentGitHubPublicationConfig,
    getSessionRowProjection: () => undefined,
    getClient: (connId) => (client.connId === connId ? client : undefined),
    resolveGatewayContext: () => context,
    broadcastToConnIds: () => {},
  });
  let services: Awaited<ReturnType<typeof startTestRepositorySessionPresentation>> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    await services?.stop({ strict: true });
    await host.close();
    await scheduler.stop();
    resetPluginRuntimeStateForTest();
  };
  onTestFinished(close);
  services = await startTestRepositorySessionPresentation(context, scheduler, client, {
    resetRuntimeOnFinish: false,
  });
  const api = () => {
    const value = readRepositoryServices(context)?.publication;
    if (!value) {
      throw new Error("The registered account service did not install its publication provider.");
    }
    return value;
  };
  api();

  const runAsAgent = <T>(run: () => T): Promise<T> =>
    withPluginRuntimeGatewayContextResolver(
      () => context,
      () =>
        withGatewayToolCallerIdentity(
          { agentId: "main", sessionKey: SESSION_KEY, gatewayContextResolver: () => context },
          run,
        ),
    );

  return {
    close,
    api,
    host,
    context,
    agentTool() {
      return runAsAgent(() => {
        const registry = getActivePluginRegistry();
        const entry = registry?.tools.find((candidate) =>
          candidate.names.includes("github_publish"),
        );
        if (!registry || !entry) throw new Error("Missing registered GitHub publication factory.");
        const toolContext = {
          agentId: "main",
          sessionKey: SESSION_KEY,
          config: context.getRuntimeConfig(),
        };
        const bindGateway = preparePluginToolGatewayCapability(
          { githubPublicationAvailable: true },
          toolContext,
        );
        const factoryContext = createPluginToolFactoryContext({
          entry,
          registry,
          context: toolContext,
          assertInvocationCurrent() {},
          bindExecutionCapabilities: (assertCurrent, signal, methods, pluginId) => ({
            gateway: bindGateway(assertCurrent, signal, methods, pluginId),
          }),
        });
        const created = entry.factory(factoryContext);
        if (!created || Array.isArray(created))
          throw new Error("Expected one plugin publication tool.");
        return {
          tool: bindPluginToolCallbacks(
            entry,
            registry,
            created,
            factoryContext.assertInvocationCurrent,
          ),
          gateway: factoryContext.gateway!,
        };
      });
    },
    execute(tool: AnyAgentTool, id: string, args: Record<string, unknown>) {
      return runAsAgent(() => tool.execute(id, args));
    },
    runAsAgent,
    async stop() {
      await services?.stop({ strict: true });
    },
    async restart() {
      services = await startTestRepositorySessionPresentation(context, scheduler, client, {
        resetRuntimeOnFinish: false,
      });
      return api();
    },
    async rpc(method: string, input: Record<string, unknown>) {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: "publication-service", method, params: input },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledOnce();
      return respond.mock.calls[0]!;
    },
  };
}

it("publishes through the registered plugin tool factory and native RPC, then retires its provider", async () => {
  await persistPublicationTestSession();
  const local = await createRealPublicationWorkspace(undefined, SESSION_KEY, {
    linkedWorktree: true,
  });
  const { readLiveRegistryWorktreeByOwner } = await vi.importActual<
    typeof import("../agents/worktrees/registry-read.js")
  >("../agents/worktrees/registry-read.js");
  mocks.readWorktree.mockImplementation(readLiveRegistryWorktreeByOwner);
  const gateway = await startPublicationGateway();
  try {
    const selected = gateway.api();
    const input = { sessionKey: SESSION_KEY, idempotencyKey: "registered-publication" };
    const registered = await gateway.agentTool();
    await expect(
      gateway.runAsAgent(() => registered.gateway.call("config.patch", {})),
    ).rejects.toThrow(/owned Gateway method/);
    const first = (await gateway.execute(registered.tool, "registered-publication", {})).details;
    expect(first).toMatchObject({ status: "published", repository: "openclaw/openclaw" });
    if (!isRecord(first) || typeof first.requestId !== "string") {
      throw new Error("Native publication RPC did not return a receipt.");
    }
    expect(local.effects).toEqual(["push", "pull_request"]);
    expect(await local.git("show", "HEAD:artifact.txt")).toBe("accepted");

    await gateway.stop();
    await expect(gateway.execute(registered.tool, "stale-plugin-tool", {})).rejects.toThrow();
    expect(readRepositoryServices(gateway.context)).toBeUndefined();
    const requester = await createSystemGitHubPublicationRequesterFixture();
    await expect(async () =>
      selected.requestForSessionV2({
        ...publicationRequest("retired-service"),
        requester: requester.requester,
      }),
    ).rejects.toThrow();
    expect(local.effects).toEqual(["push", "pull_request"]);

    expect(await gateway.restart()).not.toBe(selected);
    const replay = await gateway.rpc("sessions.github.publish", input);
    expect(replay[0], JSON.stringify(replay[2])).toBe(true);
    expect(replay[1]).toEqual(first);
    await expect(gateway.execute(registered.tool, "replaced-plugin-tool", {})).rejects.toThrow();
    expect(local.effects).toEqual(["push", "pull_request"]);
  } finally {
    await gateway.close();
  }
});

it("publishes a personal selection through the registered provider and native caller", async () => {
  await persistPublicationTestSession();
  const personal = await createPersonalPublicationFixture();
  const local = await createRealPublicationWorkspace(undefined, SESSION_KEY, {
    linkedWorktree: true,
  });
  const { readLiveRegistryWorktreeByOwner } = await vi.importActual<
    typeof import("../agents/worktrees/registry-read.js")
  >("../agents/worktrees/registry-read.js");
  mocks.readWorktree.mockImplementation(readLiveRegistryWorktreeByOwner);
  const gateway = await startPublicationGateway({
    ...personal.client,
    authenticatedUserProfile: {
      profileId: personal.owner,
      displayName: null,
      hasAvatar: false,
      avatarRevision: "none",
      updatedAt: 1,
    },
    socket: createGatewayWsTestSocket(),
    connId: personal.client.connId!,
    usesSharedGatewayAuth: true,
  });
  try {
    const result = await gateway.rpc(
      "sessions.github.publish",
      personalPublicationRequest(personal, "registered-personal"),
    );
    expect(result[0], JSON.stringify(result[2])).toBe(true);
    expect(result[1]).toMatchObject({
      status: "published",
      publisher: { source: "personal", accountId: 101 },
    });
    expect(local.effects).toEqual(["push", "pull_request"]);
    expect(await local.git("show", "HEAD:artifact.txt")).toBe("accepted");
  } finally {
    await gateway.close();
  }
});

it("retains an uncertain object publication across withdrawal and refuses a replacement account", async () => {
  const repository = await createRepositoryPublicationFixture(checkpoint);
  const original = await mocks.prepareIdentity();
  repository.runtime.interruptPush = true;
  const gateway = await startPublicationGateway();
  try {
    const oldApi = gateway.api();
    const input = { sessionKey: SESSION_KEY, idempotencyKey: "registered-object-recovery" };
    const first = await gateway.rpc("sessions.github.publish", input);
    expect(first[0], JSON.stringify(first[2])).toBe(true);
    expect(first[1]).toMatchObject({
      status: "requested",
      effect: { kind: "push", status: "dispatched" },
    });
    expect(repository.runtime.effects).toEqual(["push"]);
    if (!isRecord(first[1]) || typeof first[1].requestId !== "string") {
      throw new Error("Missing native object receipt");
    }
    const requestId = first[1].requestId;
    const read = () =>
      readRepositoryGitHubPublicationInDatabase(openOpenClawStateDatabase().db, requestId);
    const accepted = read();
    await gateway.stop();
    expect(read()).toEqual(accepted);
    mocks.prepareIdentity.mockResolvedValue({
      ...original,
      account: {
        ...original.account,
        accountId: original.account.accountId + 1,
        login: "replacement-account",
      },
    });
    await gateway.restart();
    const wrongAccount = await gateway.rpc("sessions.github.publish", input);
    expect(wrongAccount[0]).toBe(false);
    expect(read()).toEqual(accepted);
    expect(repository.runtime.effects).toEqual(["push"]);
    const requester = await createSystemGitHubPublicationRequesterFixture();
    await expect(async () =>
      oldApi.requestForSessionV2({
        ...publicationRequest("stale-instance"),
        requester: requester.requester,
      }),
    ).rejects.toThrow();
    // GitHub login casing is presentation, not a new account or accepted destination.
    mocks.prepareIdentity.mockResolvedValue({
      ...original,
      account: { ...original.account, login: original.account.login.toUpperCase() },
    });
    const resumed = await gateway.rpc("sessions.github.publish", input);
    expect(resumed[0], JSON.stringify(resumed[2])).toBe(true);
    expect(resumed[1]).toMatchObject({ status: "published", requestId });
    expect(read()).toMatchObject({
      identity_account_id: original.account.accountId,
      identity_login: original.account.login,
      repository: accepted!.repository,
      branch: accepted!.branch,
    });
    expect(repository.runtime.effects).toEqual(["push", "pull_request"]);
  } finally {
    await gateway.close();
  }
});

it("drains an admitted native RPC through a dispatched push before closing publication custody", async () => {
  await persistPublicationTestSession();
  const local = await createRealPublicationWorkspace(undefined, SESSION_KEY, {
    linkedWorktree: true,
  });
  const { readLiveRegistryWorktreeByOwner } = await vi.importActual<
    typeof import("../agents/worktrees/registry-read.js")
  >("../agents/worktrees/registry-read.js");
  mocks.readWorktree.mockImplementation(readLiveRegistryWorktreeByOwner);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const transport = mocks.runCommand.getMockImplementation()!;
  mocks.runCommand.mockImplementation(async (argv, options) => {
    if (argv.includes("push")) {
      entered.resolve();
      await release.promise;
    }
    return await transport(argv, options);
  });
  const gateway = await startPublicationGateway();
  let publishing: ReturnType<typeof gateway.rpc> | undefined;
  let closing: Promise<void> | undefined;
  try {
    publishing = gateway.rpc("sessions.github.publish", {
      sessionKey: SESSION_KEY,
      idempotencyKey: "shutdown-push",
    });
    await entered.promise;
    let drained = false;
    closing = gateway.host.close().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(
      drained,
      "Publication close must join the admitted RPC, not only individual receipt mutations",
    ).toBe(false);
    const stopping = gateway.stop();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(readRepositoryServices(gateway.context)).toBeUndefined();
    release.resolve();
    const response = await publishing;
    expect(response[0]).toBe(false);
    await Promise.all([closing, stopping]);
    const row = readGitHubPublicationRequest(openOpenClawStateDatabase().db, {
      sessionId: SESSION_ID,
      idempotencyKey: "shutdown-push",
    });
    // Shared receipts retain their accepted head, not the object/personal effect columns.
    expect(row).toMatchObject({
      status: "publishing",
      head_commit: await local.git("rev-parse", "HEAD"),
      repository: "openclaw/openclaw",
      idempotency_key: "shutdown-push",
    });
    expect(local.effects).toEqual(["push"]);
  } finally {
    release.resolve();
    await publishing;
    await closing;
    await gateway.close();
  }
});
