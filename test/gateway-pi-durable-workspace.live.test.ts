import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { isLiveTestEnabled } from "../src/agents/live-test-helpers.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { SandboxSshSettings } from "../src/config/types.sandbox.js";
import { resolveRawAssistantAnswerText } from "../src/shared/assistant-answer-text.js";
import { connectRestartClient, restartEnv } from "./gateway-restart.test-support.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const exec = promisify(execFile);
const runtime = "pi-durable-child";
const authState = process.env.OPENCLAW_LIVE_PI_DURABLE_AUTH_STATE;
const model = process.env.OPENCLAW_LIVE_PI_DURABLE_MODEL;
const image = process.env.OPENCLAW_LIVE_PI_DURABLE_SANDBOX_IMAGE;
const dockerHost = process.env.DOCKER_HOST;
const sshConfig = process.env.OPENCLAW_LIVE_PI_DURABLE_SSH_CONFIG;

type Connection = Awaited<ReturnType<typeof connectRestartClient>>;
type ChatMessage = {
  role?: string;
  content?: unknown;
  __openclaw?: { id?: string };
  openclawDeliveryMirror?: { pluginId?: string; type?: string };
};

it.skipIf(!isLiveTestEnabled() || !authState || !model || !(sshConfig || (image && dockerHost)))(
  `resumes a Pi Durable child in the same ${sshConfig ? "SSH" : "Docker"} workspace across two Gateway kills`,
  { timeout: 180_000 },
  async ({ signal }) => {
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
    const workspace = await mkdtemp(join(stateDir, "pi-sandbox-proof-"));
    const nonce = randomUUID().slice(0, 8);
    const sshSettings = sshConfig
      ? (JSON.parse(await readFile(sshConfig, "utf8")) as SandboxSshSettings)
      : undefined;
    const sshPort = sshSettings?.target?.match(/^root@127\.0\.0\.1:([0-9]+)$/)?.[1];
    if (sshSettings && (!sshPort || !sshSettings.identityFile || !sshSettings.knownHostsFile)) {
      throw new Error(
        "Use a disposable loopback SSH target with its own key and known hosts file.",
      );
    }
    const remoteRoot = `/tmp/openclaw-pi-proof-workspaces-${nonce}`;
    const prefix = `pi-proof-${nonce}-`;
    const proofFile = "pi-resume-check.txt";
    const startedMarker = "SANDBOX_WORKSPACE_READY";
    const checkpointOnly = `CHECKPOINT_${randomUUID()}`;
    const expected = `READ_${randomUUID()}`;
    const hostMarker = `DECOY_${randomUUID()}`;
    const parent = `agent:main:dashboard:${randomUUID()}`;
    const child = `agent:main:dashboard:${randomUUID()}`;
    await mkdir(join(workspace, "sandboxes"));
    await writeFile(join(workspace, proofFile), hostMarker);
    let gateway: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
    let client: Connection | undefined;
    let sandboxId: string | undefined;
    const docker = (...args: string[]) =>
      exec("docker", args, {
        env: { ...process.env, DOCKER_HOST: dockerHost, DOCKER_CONTEXT: undefined },
        timeout: 20_000,
      });
    const ssh = (...args: string[]) =>
      exec(
        "ssh",
        [
          "-p",
          sshPort!,
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          `UserKnownHostsFile=${sshSettings!.knownHostsFile}`,
          "-i",
          sshSettings!.identityFile!,
          "root@127.0.0.1",
          ...args,
        ],
        { timeout: 20_000 },
      );
    const findSandbox = async () => {
      const { stdout } = sshSettings
        ? await ssh("find", remoteRoot, "-type", "f", "-name", proofFile)
        : await docker("ps", "--filter", `name=^/${prefix}`, "--format", "{{.ID}}");
      const ids = stdout.trim().split("\n").filter(Boolean);
      expect(ids).toHaveLength(1);
      if (sshSettings) {
        expect(ids[0]).toMatch(new RegExp(`^${remoteRoot}/[a-zA-Z0-9_./-]+$`));
      }
      return ids[0]!;
    };
    await runQaGatewayFixture(
      async () => {
        gateway = await createOpenClawTestInstance({
          name: "pi-durable-workspace-live",
          config: {
            auth,
            agents: {
              defaults: {
                model: { primary: model },
                models: { [model!]: { agentRuntime: { id: "openclaw" } } },
                thinkingDefault: "low",
                skipBootstrap: true,
                workspace,
                sandbox: {
                  mode: "all",
                  scope: "session",
                  workspaceAccess: sshSettings ? "rw" : "none",
                  workspaceRoot: join(workspace, "sandboxes"),
                  ...(sshSettings
                    ? { backend: "ssh", ssh: { ...sshSettings, workspaceRoot: remoteRoot } }
                    : { docker: { image, containerPrefix: prefix, workdir: "/workspace" } }),
                },
              },
            },
            plugins: {
              allow: [runtime, "openai"],
              entries: { [runtime]: { enabled: true } },
              slots: { memory: "none" },
            },
            tools: {
              allow: ["session_status", "pi_durable_wait", "read", "write"],
              sandbox: { tools: { allow: ["session_status", "pi_durable_wait", "read", "write"] } },
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
            OPENCLAW_NO_RESPAWN: "1",
            DOCKER_CONTEXT: undefined,
            DOCKER_HOST: dockerHost,
          },
          signal,
        });
        const instance = gateway;
        const boot = async () => {
          await instance.startGateway();
          client = await connectRestartClient(instance, { requestTimeoutMs: 50_000 }, signal);
          return client;
        };
        const crash = async () => {
          await instance.crashGateway();
          await client?.stopAndWait();
          client = undefined;
        };
        const history = async (connection: Connection, sessionKey: string) =>
          (await connection.request<{ messages: ChatMessage[] }>("chat.history", { sessionKey }))
            .messages;
        const send = async (connection: Connection, sessionKey: string, message: string) => {
          const result = await connection.request<{ runId: string; status: string }>("chat.send", {
            sessionKey,
            message,
            idempotencyKey: randomUUID(),
          });
          expect(result).toMatchObject({ status: "started", runId: expect.any(String) });
          return result.runId;
        };
        const parentReply = async (connection: Connection) => {
          const marker = `PARENT_${randomUUID().slice(0, 8)}`;
          const runId = await send(connection, parent, `Reply with exactly ${marker}.`);
          await expect(
            connection.request("agent.wait", { runId, timeoutMs: 40_000 }),
          ).resolves.toMatchObject({ status: "ok" });
          expect((await history(connection, parent)).map(resolveRawAssistantAnswerText)).toContain(
            marker,
          );
        };

        const first = await boot();
        await first.request("sessions.create", { key: parent, agentId: "main" });
        await first.request("sessions.patch", { key: parent, sandboxMode: "off" });
        await first.request("sessions.create", {
          key: child,
          agentId: "main",
          parentSessionKey: parent,
          spawnDepth: 1,
          agentRuntime: runtime,
          model,
        });
        await send(
          first,
          child,
          `Run this workspace persistence check. First use write to create ${proofFile} containing ${startedMarker}. Call pi_durable_wait once. An external process will replace the file while you wait. After approval, call read to get the replacement. Your final chat reply must be only the first line from the read tool output, the one beginning with READ_, with no formatting. Do not include the second line. If read fails or returns the original contents, reply READ_FAILED.`,
        );
        const target = { sessionKey: child, agentId: "main" };
        let approvalId: string | undefined;
        await vi.waitFor(
          async () => {
            const result = await first.request<{ id: string; state: string }>(
              `${runtime}.status`,
              target,
            );
            expect(result, instance.logs().split("\n").slice(-20).join("\n")).toMatchObject({
              state: "waiting",
            });
            const id = `durable:${runtime}:${result.id}`;
            expect(
              (await history(first, parent)).map(resolveRawAssistantAnswerText).join("\n"),
            ).toContain(id);
            approvalId = id;
          },
          { timeout: 40_000, interval: 150 },
        );
        sandboxId = await findSandbox();
        const readOriginal = sshSettings
          ? await ssh("cat", sandboxId)
          : await docker("exec", sandboxId, "cat", `/workspace/${proofFile}`);
        expect(readOriginal.stdout.trim()).toBe(startedMarker);
        await parentReply(first);
        await crash();

        // This value has never appeared in OpenClaw or model input.
        if (sshSettings) {
          await ssh("printf", "'%s\\n%s'", expected, checkpointOnly, ">", sandboxId);
        } else {
          await docker(
            "exec",
            sandboxId,
            "sh",
            "-c",
            'printf "%s\\n%s" "$1" "$2" > "$3"',
            "pi-proof",
            expected,
            checkpointOnly,
            `/workspace/${proofFile}`,
          );
        }
        const second = await boot();
        await expect(second.request(`${runtime}.status`, target)).resolves.toMatchObject({
          state: "waiting",
        });
        await parentReply(second);
        const approval = await send(second, parent, `/approve ${approvalId} allow-once`);
        await expect(
          second.request("agent.wait", { runId: approval, timeoutMs: 15_000 }),
        ).resolves.toMatchObject({ status: "ok" });
        const wake = `Resuming Pi Durable child ${approvalId?.split(":").at(-1)}`;
        await crash();
        expect(instance.logs()).not.toContain(wake);

        const third = await boot();
        const activeParent = parentReply(third);
        const readCompletion = (connection: Connection, key: string) =>
          history(connection, key).then((messages) =>
            messages
              .filter(
                ({ openclawDeliveryMirror: notice }) =>
                  notice?.pluginId === runtime && notice.type === "completed",
              )
              .map(resolveRawAssistantAnswerText),
          );
        await vi.waitFor(
          async () => {
            expect(
              await readCompletion(third, child),
              instance.logs().split("\n").slice(-20).join("\n"),
            ).toEqual([expected]);
            expect(await readCompletion(third, parent)).toEqual([expected]);
          },
          { timeout: 40_000, interval: 200 },
        );
        await activeParent;
        expect(instance.logs()).toContain(wake);
        expect(await readFile(join(workspace, proofFile), "utf8")).toBe(hostMarker);
        expect(await findSandbox()).toBe(sandboxId);
        const pivotPrompt = "Reply with exactly CHECKPOINT_PIVOT. Do not use any tools.";
        const pivotRun = await send(third, child, pivotPrompt);
        await expect(
          third.request("agent.wait", { runId: pivotRun, timeoutMs: 40_000 }),
        ).resolves.toMatchObject({ status: "ok" });
        const sourceHistory = await history(third, child);
        const pivot = sourceHistory.find(
          ({ role, content }) => role === "user" && JSON.stringify(content).includes(pivotPrompt),
        )?.["__openclaw"]?.id;
        expect(pivot).toBeDefined();
        expect(
          JSON.stringify(sourceHistory.filter(({ role }) => role !== "toolResult")),
        ).not.toContain(checkpointOnly);
        const branch = await third.request<{ sessionKey: string }>("sessions.fork", {
          sessionKey: child,
          entryId: pivot,
          agentId: "main",
        });
        const branchRun = await send(
          third,
          branch.sessionKey,
          "The previous file read tool returned two lines. Reply with exactly the second line beginning with CHECKPOINT_. Use the earlier tool result from this chat and do not call any tools. If no prior tool result exists, reply NO_CHECKPOINT.",
        );
        await expect(
          third.request("agent.wait", { runId: branchRun, timeoutMs: 40_000 }),
        ).resolves.toMatchObject({ status: "ok" });
        const branchHistory = await history(third, branch.sessionKey);
        expect(branchHistory.map(resolveRawAssistantAnswerText)).toContain(checkpointOnly);
        expect(JSON.stringify(branchHistory)).not.toContain(pivotPrompt);
        console.log(
          `Pi Durable live proof: original ${sshSettings ? "SSH workspace" : "Docker container"}, two Gateway kills, result once in each chat, parent replies before and after restart, and a fork that recalled an earlier tool result`,
        );
      },
      () => client?.stopAndWait(),
      () => gateway?.cleanup(),
      async () => {
        if (sshSettings) {
          await ssh("rm", "-rf", "--", remoteRoot);
          return;
        }
        const containers = (
          await docker("ps", "-a", "--filter", `name=^/${prefix}`, "--format", "{{.ID}}")
        ).stdout
          .trim()
          .split("\n")
          .filter(Boolean);
        if (containers.length) {
          await docker("rm", "-f", ...containers);
        }
      },
      () => rm(workspace, { recursive: true, force: true }),
    );
  },
);
