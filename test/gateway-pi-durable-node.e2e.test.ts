import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { resolveRawAssistantAnswerText } from "../src/shared/assistant-answer-text.js";
import {
  approvePairing,
  createChildEnv,
  readNode,
  startNodeProcess,
  stopChild,
  type CapturedChild,
  type GatewayHandle,
} from "./e2e/qa-lab/runtime/gateway-node-mcp.test-support.js";
import {
  closeWireServer,
  createPublishedWireWorkspace,
} from "./e2e/qa-lab/runtime/paired-node-worker-wire-fixture.js";
import {
  connectRestartClient,
  restartEnv,
  writeRestartToolCall,
} from "./gateway-restart.test-support.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const runtime = "pi-durable-child";
const nodeCommand = "pi-durable.workspace.exec.v1";
type Connection = Awaited<ReturnType<typeof connectRestartClient>>;

it
  .skipIf(process.platform !== "linux" && process.platform !== "darwin")
  .for(["paired device", "worker profile"] as const)(
  "recovers an approved Pi Durable child in the original workspace selected by %s",
  { timeout: 240_000 },
  async (destination, { signal }) => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-pi-paired-"));
    let gateway: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
    let client: Connection | undefined;
    let node: CapturedChild | undefined;
    const repo = await createPublishedWireWorkspace(root);
    const nodeHome = join(root, "node-home");
    const nodeTmp = join(root, "tmp");
    const nodeState = join(root, "node-state");
    const nodeIdentityEnv = { OPENCLAW_HOME: nodeHome, OPENCLAW_STATE_DIR: nodeState };
    const modelId = "pi-node-fixture";
    const model = `mock-openai/${modelId}`;
    const parent = `agent:main:dashboard:${randomUUID()}`;
    const child = `agent:main:dashboard:${randomUUID()}`;
    const original = "PAIRED_WORKSPACE_READY";
    const expected = `WORKER_ONLY_${randomUUID()}`;
    let requestId = 0;
    let execReceipt: unknown;
    const provider = await startOpenAiResponsesModelServer({
      modelId,
      bindError: "Pi paired fixture provider did not listen",
      async onRequest(request, response) {
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
        }
        const id = ++requestId;
        if (body.includes("PI_PAIRED_PROOF")) {
          if (!body.includes('"call_id":"call_pi-placed-exec_')) {
            writeRestartToolCall(
              response,
              "pi-placed-exec",
              "exec",
              {
                command: `printf %s ${original} > proof.txt`,
              },
              id,
            );
            return;
          }
          const wire = JSON.parse(body) as {
            input?: Array<{ type: string; call_id?: string; output?: unknown }>;
          };
          execReceipt = wire.input?.find(
            ({ type, call_id }) =>
              type === "function_call_output" && call_id?.startsWith("call_pi-placed-exec_"),
          )?.output;
          if (!body.includes('"call_id":"call_pi-placed-wait_')) {
            writeRestartToolCall(response, "pi-placed-wait", "pi_durable_wait", {}, id);
            return;
          }
          if (!body.includes('"call_id":"call_pi-resumed-exec_')) {
            writeRestartToolCall(
              response,
              "pi-resumed-exec",
              "exec",
              {
                command: "pwd -P > execution-root.txt",
              },
              id,
            );
            return;
          }
          if (!body.includes('"call_id":"call_pi-placed-read_')) {
            writeRestartToolCall(response, "pi-placed-read", "read", { path: "proof.txt" }, id);
            return;
          }
        }
        const parentMarker = body.match(/PARENT_[a-f0-9]{8}/gu)?.at(-1);
        const text = body.includes("PI_PAIRED_PROOF")
          ? body.includes(expected)
            ? expected
            : "WORKER_READ_FAILED"
          : (parentMarker ?? "Fixture ready");
        writeOpenAiResponsesText(response, {
          text,
          messageId: `msg_${id}`,
          responseId: `resp_${id}`,
        });
      },
    });
    let approving: Promise<void> | undefined;
    let approvalLoop: AbortController | undefined;
    await runQaGatewayFixture(
      async () => {
        const config = createOpenAiResponsesModelConfig({
          baseUrl: provider.baseUrl,
          providerId: "mock-openai",
          modelId,
          reasoning: false,
          toolProfile: "full",
        });
        const allow = ["read", "write", "exec", "session_status", "pi_durable_wait"];
        await Promise.all([nodeHome, nodeTmp, nodeState].map((dir) => mkdir(dir)));
        const { deviceId } = loadOrCreateDeviceIdentity({ env: nodeIdentityEnv });
        const profileId = "pi-recovery";
        gateway = await createOpenClawTestInstance({
          name: "pi-durable-paired",
          config: {
            ...config,
            gateway: {
              nodes: {
                commands: { allow: [nodeCommand] },
                pairing: { autoApproveLocal: false, sshVerify: false },
              },
            },
            nodeHost: { workerRuns: { enabled: true } },
            ...(destination === "worker profile"
              ? {
                  cloudWorkers: {
                    profiles: {
                      [profileId]: { provider: "device", settings: { device: deviceId } },
                    },
                  },
                }
              : {}),
            plugins: {
              allow: [runtime, "openai"],
              entries: { [runtime]: { enabled: true } },
              slots: { memory: "none" },
            },
            tools: {
              ...config.tools,
              allow,
              sandbox: { tools: { allow } },
              codeMode: { enabled: false },
            },
            update: { checkOnStart: false },
            browser: { enabled: false },
            logging: { consoleLevel: "info" },
            discovery: { mdns: { mode: "off" } },
          } satisfies OpenClawConfig,
          env: { ...restartEnv, OPENCLAW_NO_RESPAWN: "1" },
          signal,
        });
        const instance = gateway;
        const boot = async () => {
          await instance.startGateway();
          client = await connectRestartClient(
            instance,
            {
              caps: ["plugin-approvals"],
              scopes: [
                "operator.admin",
                "operator.write",
                "operator.read",
                "operator.approvals",
                "operator.pairing",
              ],
              requestTimeoutMs: 80_000,
            },
            signal,
          );
          return client;
        };
        const stopReviewing = async () => {
          approvalLoop?.abort();
          await approving;
          approvalLoop = undefined;
          approving = undefined;
        };
        const startReviewing = (connection: Connection) => {
          const controller = new AbortController();
          approvalLoop = controller;
          approving = (async () => {
            while (!controller.signal.aborted) {
              const pending = await connection.request<
                Array<{ id: string; request?: { pluginId?: string } }>
              >("plugin.approval.list", {});
              for (const approval of pending) {
                if (approval.request?.pluginId === runtime) {
                  await connection.request("plugin.approval.resolve", {
                    id: approval.id,
                    decision: "allow-always",
                  });
                }
              }
              await delay(100);
            }
          })();
          // The test joins the reviewer before each disconnect and at teardown.
          void approving.catch(() => {});
        };
        const crash = async () => {
          await stopReviewing();
          await instance.crashGateway();
          await client?.stopAndWait();
          client = undefined;
        };
        const first = await boot();
        const nodeConfigPath = join(nodeState, "openclaw.json");
        await writeFile(
          nodeConfigPath,
          JSON.stringify({
            gateway: { mode: "local" },
            plugins: { allow: [runtime], entries: { [runtime]: { enabled: true } } },
            nodeHost: { workerRuns: { enabled: true }, skills: { enabled: false } },
            tools: { exec: { mode: "full" } },
          } satisfies OpenClawConfig),
        );
        const nodeEnv = createChildEnv({
          home: nodeHome,
          tempDir: nodeTmp,
          extra: {
            ...nodeIdentityEnv,
            OPENCLAW_CONFIG_PATH: nodeConfigPath,
            OPENCLAW_GATEWAY_TOKEN: instance.gatewayToken,
            OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
          },
        });
        node = startNodeProcess(instance.port, nodeEnv);
        const fixtureGateway = {
          call: (method: string, args: Record<string, unknown>) => first.request(method, args),
          logs: () => instance.logs() + "\n" + node?.logs(),
        } satisfies Pick<GatewayHandle, "call" | "logs">;
        const nodeId = await approvePairing(fixtureGateway, "device");
        expect(nodeId).toBe(deviceId);
        await stopChild(node);
        node = startNodeProcess(instance.port, nodeEnv);
        await approvePairing(fixtureGateway, "node", nodeId);
        await stopChild(node);
        node = startNodeProcess(instance.port, nodeEnv);
        const connected = async (connection: Connection) => {
          await vi.waitFor(
            async () => {
              expect(
                await readNode(
                  { ...fixtureGateway, call: (method, args) => connection.request(method, args) },
                  nodeId,
                ),
              ).toMatchObject({
                connected: true,
                commands: expect.arrayContaining([nodeCommand]),
              });
            },
            { timeout: 60_000, interval: 200 },
          );
        };
        await connected(first);
        await first.request("sessions.create", { key: parent, agentId: "main" });
        await first.request("sessions.create", {
          key: child,
          agentId: "main",
          agentRuntime: runtime,
          parentSessionKey: parent,
          spawnDepth: 1,
          model,
          worktree: true,
          worktreeName: "pi-paired-recovery",
          worktreeBaseRef: "main",
          cwd: repo.source,
        });
        const placed = await first.request<{
          placement: { state: string; remoteWorkspaceDir: string; environmentId: string };
        }>("sessions.dispatch", {
          key: child,
          ...(destination === "worker profile" ? { profileId } : { deviceId: nodeId }),
        });
        expect(placed.placement).toMatchObject({
          state: "active",
          remoteWorkspaceDir: expect.any(String),
        });
        const remoteFile = join(placed.placement.remoteWorkspaceDir, "proof.txt");
        const send = async (connection: Connection, sessionKey: string, message: string) => {
          const { runId } = await connection.request<{ runId: string }>("chat.send", {
            sessionKey,
            message,
            idempotencyKey: randomUUID(),
          });
          return runId;
        };
        const history = async (connection: Connection, sessionKey: string) =>
          (
            await connection.request<{ messages: unknown[] }>("chat.history", { sessionKey })
          ).messages.map(resolveRawAssistantAnswerText);
        const reply = async (connection: Connection) => {
          const marker = `PARENT_${randomUUID().slice(0, 8)}`;
          const runId = await send(connection, parent, `Reply with exactly ${marker}.`);
          await expect(
            connection.request("agent.wait", { runId, timeoutMs: 30_000 }),
          ).resolves.toMatchObject({ status: "ok" });
          expect(await history(connection, parent)).toContain(marker);
        };
        startReviewing(first);
        const parkedRun = await send(first, child, "PI_PAIRED_PROOF");
        const target = { sessionKey: child, agentId: "main" };
        let approval = "";
        await vi.waitFor(
          async () => {
            const state = await first.request<{ state: string; id: string }>(
              `${runtime}.status`,
              target,
            );
            expect(state, instance.logs() + "\n" + node?.logs()).toMatchObject({
              state: "waiting",
            });
            approval = `durable:${runtime}:${state.id}`;
            expect((await history(first, parent)).join("\n")).toContain(approval);
          },
          { timeout: 65_000, interval: 200 },
        );
        const contents = await readFile(remoteFile, "utf8").catch((error: unknown) => {
          throw new Error(
            `Worker exec receipt: ${JSON.stringify(execReceipt)}\n${instance.logs().split("\n").slice(-24).join("\n")}\n${node?.logs()}`,
            { cause: error },
          );
        });
        expect(contents).toBe(original);
        await expect(
          first.request("agent.wait", { runId: parkedRun, timeoutMs: 35_000 }),
        ).resolves.toMatchObject({ status: "ok" });
        await reply(first);
        await crash();

        await writeFile(remoteFile, expected);
        const second = await boot();
        await connected(second);
        await reply(second);
        const approved = await send(second, parent, `/approve ${approval} allow-once`);
        await expect(
          second.request("agent.wait", { runId: approved, timeoutMs: 15_000 }),
        ).resolves.toMatchObject({ status: "ok" });
        await crash();
        const wake = `Resuming Pi Durable child ${approval.split(":").at(-1)}`;
        expect(instance.logs()).not.toContain(wake);
        await stopChild(node);
        node = undefined;
        const third = await boot();
        startReviewing(third);
        await reply(third);
        expect(instance.logs()).not.toContain(wake);
        node = startNodeProcess(instance.port, nodeEnv);
        await connected(third);
        await vi.waitFor(
          async () => {
            for (const key of [child, parent]) {
              const answers = await history(third, key);
              expect(
                answers.filter((text) => text === expected || text === "WORKER_READ_FAILED"),
                instance.logs() + "\n" + node?.logs(),
              ).toEqual([expected]);
              if (key === parent) {
                expect(
                  answers.filter(
                    (text) =>
                      text.startsWith("Pi Durable child is waiting for your approval.") &&
                      text.includes(approval),
                  ),
                ).toHaveLength(1);
              }
            }
          },
          { timeout: 65_000, interval: 200 },
        );
        expect(instance.logs()).toContain(wake);
        expect(
          (
            await readFile(join(placed.placement.remoteWorkspaceDir, "execution-root.txt"), "utf8")
          ).trim(),
        ).toBe(await realpath(placed.placement.remoteWorkspaceDir));
        expect(await readFile(remoteFile, "utf8")).toBe(expected);
        await stopReviewing();
      },
      async () => {
        approvalLoop?.abort();
        await approving?.catch(() => {});
      },
      () => client?.stopAndWait(),
      () => stopChild(node),
      () => gateway?.cleanup(),
      () => provider.close(),
      () => closeWireServer(repo.server),
      () => rm(root, { recursive: true, force: true }),
    );
  },
);
