import { randomUUID } from "node:crypto";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { isLiveTestEnabled } from "../src/agents/live-test-helpers.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { resolveRawAssistantAnswerText } from "../src/shared/assistant-answer-text.js";
import { resolveTestNodeExecPath } from "../src/test-utils/node-process.js";
import { connectRestartClient, restartEnv } from "./gateway-restart.test-support.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const runtime = "pi-durable-child";
const authState = process.env.OPENCLAW_LIVE_PI_DURABLE_AUTH_STATE;
const model = process.env.OPENCLAW_LIVE_PI_DURABLE_MODEL;
const enabled = isLiveTestEnabled() && Boolean(authState && model);

it.skipIf(!enabled)(
  "recovers each committed Pi notice once across Gateway kills while the parent keeps chatting",
  { timeout: 270_000 },
  async ({ signal }) => {
    // Use the disposable state where OpenClaw itself performed the OAuth login.
    // The fixture supplies its own config, port, client identity, and workspace.
    const stateDir = await realpath(authState!);
    if (
      basename(stateDir) !== "state" ||
      !basename(dirname(stateDir)).startsWith("openclaw-pi-live-auth.")
    ) {
      throw new Error("Use a disposable state directory created for the Pi Durable live proof.");
    }
    const { auth } = JSON.parse(await readFile(join(stateDir, "openclaw.json"), "utf8")) as Pick<
      OpenClawConfig,
      "auth"
    >;
    let gateway: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
    let client: Awaited<ReturnType<typeof connectRestartClient>> | undefined;
    const faultPath = join(stateDir, `notice-cut-${randomUUID()}`);
    const cutReceipt = `${faultPath}.paused`;
    // Observe the real synchronous publication log. Pause the Gateway before
    // the logger returns, so the next statement cannot invoke the notice writer.
    const pauseAtBoundary = `
      import { readFileSync, writeFileSync } from "node:fs";
      import { createRequire, syncBuiltinESMExports } from "node:module";
      const stage = ${JSON.stringify(faultPath)};
      const pause = () => {
        writeFileSync(${JSON.stringify(cutReceipt)}, String(process.pid));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
      };
      const threads = createRequire(process.cwd() + "/openclaw-live-proof.cjs")("node:worker_threads");
      const OriginalWorker = threads.Worker;
      threads.Worker = class extends OriginalWorker {
        constructor(file, options) {
          const command = options?.workerData?.command;
          if (command?.action === "start" && command.prompt.includes("PI_PRECOMMIT_PROOF") &&
              readFileSync(stage, "utf8") === "precommit") {
            pause();
          }
          super(file, options);
        }
      };
      syncBuiltinESMExports();
      for (const stream of [process.stdout, process.stderr]) {
        const write = stream.write;
        stream.write = function (chunk, ...args) {
          const type = /Publishing Pi Durable (approval|completed) notice for [a-f0-9]{64}/.exec(String(chunk))?.[1];
          if (type && readFileSync(stage, { encoding: "utf8", flag: "r" }) === type) {
            pause();
          }
          return write.call(this, chunk, ...args);
        };
      }
    `;
    await writeFile(faultPath, "");
    await runQaGatewayFixture(
      async () => {
        gateway = await createOpenClawTestInstance({
          name: "pi-durable-live",
          gatewayCommandPrefix: [
            resolveTestNodeExecPath(),
            `--import=data:text/javascript,${encodeURIComponent(pauseAtBoundary)}`,
          ],
          config: {
            auth,
            agents: {
              defaults: {
                model: { primary: model },
                models: { [model!]: { agentRuntime: { id: "openclaw" } } },
                thinkingDefault: "low",
                skipBootstrap: true,
                workspace: join(stateDir, "workspace"),
              },
            },
            plugins: {
              allow: [runtime, "openai"],
              entries: { [runtime]: { enabled: true } },
              slots: { memory: "none" },
            },
            tools: {
              profile: "full",
              allow: ["sessions_spawn", "session_status", "pi_durable_wait", "read"],
              codeMode: { enabled: false },
            },
            update: { checkOnStart: false },
            browser: { enabled: false },
            discovery: { mdns: { mode: "off" } },
            logging: { consoleLevel: "info" },
          } satisfies OpenClawConfig,
          env: {
            ...restartEnv,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_AGENT_DIR: undefined,
            OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
            OPENCLAW_NO_RESPAWN: "1",
          },
          signal,
        });
        const instance = gateway;
        const authList = await instance.cli([
          "models",
          "auth",
          "list",
          "--provider",
          "openai",
          "--json",
        ]);
        expect(authList.code).toBe(0);
        const { profiles } = JSON.parse(authList.stdout) as {
          profiles: Array<{ provider: string; type: string }>;
        };
        expect(profiles.map(({ provider, type }) => ({ provider, type }))).toEqual([
          { provider: "openai", type: "oauth" },
        ]);

        const boot = async () => {
          await instance.startGateway();
          client = await connectRestartClient(instance, { requestTimeoutMs: 60_000 }, signal);
          return client;
        };
        const crash = async () => {
          await instance.crashGateway();
          await client?.stopAndWait();
          client = undefined;
        };
        const crashAtBoundary = async () => {
          const pid = await vi.waitFor(async () => Number(await readFile(cutReceipt, "utf8")), {
            timeout: 45_000,
          });
          const instancePid = /"pid":\s*(\d+)/.exec(await instance.diagnose())?.[1];
          expect(pid).toBe(Number(instancePid));
          await crash();
          await writeFile(faultPath, "");
          await rm(cutReceipt);
        };
        const restart = async () => {
          await client?.stopAndWait();
          client = undefined;
          await instance.stopGateway();
          return await boot();
        };
        const parent = `agent:main:dashboard:pi-parent-${randomUUID()}`;
        const child = `agent:main:dashboard:pi-child-${randomUUID()}`;
        const approved = `APPROVED_${randomUUID().slice(0, 8)}`;
        type Connection = NonNullable<typeof client>;
        type ChatMessage = {
          role?: string;
          content?: unknown;
          openclawDeliveryMirror?: { pluginId?: string; type?: string; data?: { id?: string } };
        };
        const history = async (connection: Connection, sessionKey: string) => {
          const { messages } = await connection.request<{
            messages: ChatMessage[];
          }>("chat.history", { sessionKey });
          return messages.filter(({ role }) => role === "assistant");
        };
        const assistantTexts = async (connection: Connection, sessionKey: string) =>
          (await history(connection, sessionKey)).map((message) =>
            resolveRawAssistantAnswerText(message).trim(),
          );
        const notices = async (connection: Connection, sessionKey: string, type: string) =>
          (await history(connection, sessionKey)).filter(
            ({ openclawDeliveryMirror: notice }) =>
              notice?.pluginId === runtime && notice.type === type,
          );
        const send = (connection: Connection, sessionKey: string, message: string) =>
          connection.request<{ runId: string }>("chat.send", {
            sessionKey,
            message,
            idempotencyKey: randomUUID(),
          });
        const finish = async (connection: Connection, runId: string) => {
          const outcome = await vi.waitFor(
            async () => {
              const result = await connection.request<{ status: string }>("agent.wait", {
                runId,
                timeoutMs: 45_000,
              });
              expect(result.status).not.toBe("pending");
              return result;
            },
            { timeout: 45_000, interval: 200 },
          );
          expect(outcome, instance.logs().split("\n").slice(-20).join("\n")).toMatchObject({
            status: "ok",
          });
        };
        const sendParent = async (connection: Connection) => {
          const marker = `PARENT_${randomUUID().slice(0, 8)}`;
          return {
            marker,
            ...(await send(
              connection,
              parent,
              `Reply with exactly ${marker} as plain text. Do not call tools.`,
            )),
          };
        };
        const finishParent = async (
          connection: Connection,
          pending: Awaited<ReturnType<typeof sendParent>>,
        ) => {
          await finish(connection, pending.runId);
          await vi.waitFor(
            async () => expect(await assistantTexts(connection, parent)).toContain(pending.marker),
            { timeout: 10_000 },
          );
        };

        const opening = await boot();
        await opening.request("sessions.create", { key: parent, agentId: "main" });
        await finishParent(opening, await sendParent(opening));
        const precommitChat = `agent:main:dashboard:pi-precommit-${randomUUID()}`;
        const precommitMarker = `PI_RECOVERED_${randomUUID().slice(0, 8)}`;
        await opening.request("sessions.create", {
          key: precommitChat,
          agentId: "main",
          agentRuntime: runtime,
          model,
        });
        await writeFile(faultPath, "precommit");
        await send(
          opening,
          precommitChat,
          `PI_PRECOMMIT_PROOF. Reply with exactly ${precommitMarker}.`,
        );
        await crashAtBoundary();
        console.log("Pi Durable live proof: killed Gateway before the first Pi worker started");
        const first = await boot();
        const parentDuringPrecommitRecovery = await sendParent(first);
        await vi.waitFor(
          async () => expect(await assistantTexts(first, precommitChat)).toEqual([precommitMarker]),
          { timeout: 40_000, interval: 200 },
        );
        await finishParent(first, parentDuringPrecommitRecovery);
        expect(await notices(first, parent, "approval")).toHaveLength(0);
        await writeFile(faultPath, "approval");
        const task = `Call pi_durable_wait exactly once with empty arguments. Wait for its result. If approval was granted and this session verified, reply exactly ${approved} in plain text. On denial reply DENIED.`;
        // Leave no in-flight parent model turn for the Gateway to resume.
        await first.request("sessions.create", {
          key: child,
          agentId: "main",
          parentSessionKey: parent,
          spawnDepth: 1,
          agentRuntime: runtime,
          model,
        });
        await send(first, child, task);
        await crashAtBoundary();
        console.log(
          "Pi Durable live proof: killed Gateway after the park committed, before its approval notice",
        );

        const second = await boot();
        let approvalNotice: ChatMessage | undefined;
        await vi.waitFor(
          async () => {
            const posted = await notices(second, parent, "approval");
            expect(posted, instance.logs().split("\n").slice(-25).join("\n")).toHaveLength(1);
            approvalNotice = posted[0];
          },
          { timeout: 40_000, interval: 175 },
        );
        const id = approvalNotice?.openclawDeliveryMirror?.data?.id;
        expect(id).toMatch(/^[a-f0-9]{64}_[a-f0-9]{64}$/);
        const approvalId = `durable:${runtime}:${id}`;
        expect(resolveRawAssistantAnswerText(approvalNotice!)).toContain(`/approve ${approvalId}`);
        await expect(second.request("sessions.describe", { key: child })).resolves.toMatchObject({
          session: { parentSessionKey: parent },
        });
        const target = { sessionKey: child, agentId: "main" };
        await expect(second.request("pi-durable-child.status", target)).resolves.toEqual({
          id,
          state: "waiting",
        });
        await finishParent(second, await sendParent(second));
        const approvalReplay = `Reconciled Pi Durable waiting notices for ${id}`;
        const review = await restart();
        await vi.waitFor(() => expect(instance.logs().split(approvalReplay)).toHaveLength(3), {
          timeout: 25_000,
        });
        await expect(review.request("pi-durable-child.status", target)).resolves.toMatchObject({
          state: "waiting",
        });
        expect(await notices(review, parent, "approval")).toHaveLength(1);
        const unrelated = `agent:main:dashboard:pi-unrelated-${randomUUID()}`;
        await review.request("sessions.create", { key: unrelated, agentId: "main" });
        const slash = `/approve ${approvalId} allow-once`;
        const wrongChat = await send(review, unrelated, slash);
        await finish(review, wrongChat.runId);
        expect((await assistantTexts(review, unrelated)).join("\n")).toContain(
          "That approval is unavailable in the current chat",
        );
        await expect(review.request("pi-durable-child.status", target)).resolves.toEqual({
          id,
          state: "waiting",
        });

        const approval = await send(review, parent, slash);
        await finish(review, approval.runId);
        expect((await assistantTexts(review, parent)).join("\n")).toContain(
          `Approval allow-once submitted for ${approvalId}`,
        );
        expect(await notices(review, parent, "completed")).toHaveLength(0);
        expect(await notices(review, child, "completed")).toHaveLength(0);
        await crash();
        const resumed = `Resuming Pi Durable child ${id}`;
        expect(instance.logs()).not.toContain(resumed);
        console.log("Pi Durable live proof: approval committed before the second Gateway kill");

        await writeFile(faultPath, "completed");
        await boot();
        await crashAtBoundary();
        console.log(
          "Pi Durable live proof: killed Gateway after the result committed, before its notices",
        );

        const expectNotices = async (connection: Connection) => {
          expect(await notices(connection, parent, "approval")).toHaveLength(1);
          for (const sessionKey of [child, parent]) {
            const posted = await notices(connection, sessionKey, "completed");
            expect(posted).toHaveLength(1);
            expect(resolveRawAssistantAnswerText(posted[0]!)).toBe(approved);
          }
        };
        const recovered = await boot();
        const duringRecovery = await sendParent(recovered);
        await vi.waitFor(() => expectNotices(recovered), { timeout: 30_000, interval: 175 });
        await finishParent(recovered, duringRecovery);
        await expect(recovered.request("pi-durable-child.status", target)).resolves.toEqual({
          id,
          state: "completed",
          result: { text: approved },
        });
        const resultReplay = `Reconciled Pi Durable completed notices for ${id}`;
        const restarted = await restart();
        await vi.waitFor(() => expect(instance.logs().split(resultReplay)).toHaveLength(3), {
          timeout: 25_000,
        });
        // Status joins the child's recovery after it starts the repeat writes.
        await expect(restarted.request("pi-durable-child.status", target)).resolves.toMatchObject({
          state: "completed",
        });
        await finishParent(restarted, await sendParent(restarted));
        await expectNotices(restarted);
        expect(instance.logs().split(resumed)).toHaveLength(2);
        const toolMarker = `FILE_${randomUUID().slice(0, 8)}`;
        await writeFile(join(stateDir, "workspace", "PI_TOOL_PROOF.txt"), toolMarker);
        const normalTool = await send(
          restarted,
          child,
          "Use the read tool on PI_TOOL_PROOF.txt in your workspace. Reply with just the file's contents.",
        );
        await finish(restarted, normalTool.runId);
        await vi.waitFor(async () =>
          expect(await assistantTexts(restarted, child)).toContain(toolMarker),
        );

        const afterRestart = await restart();
        const followup = await send(
          afterRestart,
          child,
          "Repeat the exact marker from your immediately previous answer. Do not call any tools.",
        );
        await finish(afterRestart, followup.runId);
        await vi.waitFor(async () =>
          expect(
            (await assistantTexts(afterRestart, child)).filter((text) => text === toolMarker),
          ).toHaveLength(2),
        );

        await send(
          afterRestart,
          child,
          "Call pi_durable_wait exactly once to request another approval.",
        );
        let nextApprovalId: string | undefined;
        await vi.waitFor(
          async () => {
            const posted = await notices(afterRestart, parent, "approval");
            expect(posted).toHaveLength(2);
            nextApprovalId = posted.at(-1)?.openclawDeliveryMirror?.data?.id;
            expect(nextApprovalId).toBeDefined();
            expect(nextApprovalId).not.toBe(id);
          },
          { timeout: 40_000, interval: 200 },
        );
        await expect(send(afterRestart, child, "/stop")).resolves.toMatchObject({ aborted: true });
        const afterStop = await restart();
        await expect(afterStop.request("pi-durable-child.status", target)).resolves.toMatchObject({
          state: "cancelled",
        });
        const stale = await send(
          afterStop,
          parent,
          `/approve durable:${runtime}:${nextApprovalId} allow-once`,
        );
        await finish(afterStop, stale.runId);
        expect((await assistantTexts(afterStop, parent)).join("\n")).toContain(
          "has already closed",
        );
        const postStopMarker = `AFTER_STOP_${randomUUID().slice(0, 8)}`;
        const postStop = await send(afterStop, child, `Reply with exactly ${postStopMarker}.`);
        await finish(afterStop, postStop.runId);
        await vi.waitFor(async () =>
          expect(await assistantTexts(afterStop, child)).toContain(postStopMarker),
        );
        console.log(
          `Pi Durable live proof: ${model} with OpenClaw OAuth, four kills, original input before Pi journals it, one resumed approval, one result per chat, five parent replies, a real read tool, chat history after restart, and durable Stop`,
        );
      },
      () => client?.stopAndWait(),
      () => gateway?.cleanup(),
      () => rm(faultPath, { force: true }),
      () => rm(cutReceipt, { force: true }),
    );
  },
);
