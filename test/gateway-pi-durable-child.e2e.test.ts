import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { providerResponse } from "../src/agents/embedded-agent-runner.wire.test-support.js";
import {
  connectRestartClient,
  restartEnv,
  writeRestartPlugin,
  writeRestartToolCall,
} from "./gateway-restart.test-support.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const pluginId = "pi-durable-child";

async function holdModelAfterText(response: ServerResponse, id: string, delta: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id, type: "message", role: "assistant", status: "in_progress", content: [] },
    },
    { type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta },
  ]) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  await new Promise<void>((resolve) => {
    response.once("close", resolve);
  });
}

it(
  "keeps the parent usable while recovering an authorized Pi child across approval, inference and tool kills",
  { timeout: 180_000 },
  async ({ signal }) => {
    const modelId = "parent-proof";
    const childModelId = "pi-child-proof";
    const extraModelId = "claude-haiku-4-5";
    let anthropicRequest: { apiKey: string | string[] | undefined; body: string } | undefined;
    const anthropic = createServer((request, response) => {
      if (request.method !== "POST" || !request.url?.endsWith("/messages")) {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        anthropicRequest = { apiKey: request.headers["x-api-key"], body };
        const { response: wire } = providerResponse({
          api: "anthropic-messages",
          model: extraModelId,
          id: "msg_pi",
          messageId: "msg_pi",
          text: body.includes("PI_ANTHROPIC_SIDE_QUESTION")
            ? "ANTHROPIC_PI_SIDE_REPLY"
            : "ANTHROPIC_PI_REPLY",
          calls: [],
        });
        void wire.text().then(
          (responseBody) => {
            response.writeHead(200, { "content-type": "text/event-stream" }).end(responseBody);
          },
          () => {
            response.writeHead(500).end();
          },
        );
      });
    });
    anthropic.listen(0, "127.0.0.1");
    await once(anthropic, "listening");
    const anthropicAddress = anthropic.address();
    if (!anthropicAddress || typeof anthropicAddress === "string") {
      throw new Error("Fixture Anthropic server did not listen.");
    }
    let earlyRequests = 0;
    let forkRequest: string | undefined;
    const steerGate = Promise.withResolvers<void>();
    let steeringInference = false;
    let nextResponse = 0;
    let pendingPiInference: "waiting" | "closed" | undefined;
    const previewRuns = new Set<string>();
    const recoveredPreviews = new Set<string>();
    const sideResults = new Map<string, string>();
    let summaryReachedChat = false;
    let summaryRequests = 0;
    let concurrentCompaction = false;
    let pendingGeneration = 0;
    let pendingSummaries = 0;
    let appModelRequest: { tools?: { name: string }[]; instructions?: string } | undefined;
    const childRequests: {
      model: string;
      authorization?: string;
      tools?: string[];
      toolTranscript?: { type: string; name?: string; call_id?: string; output?: unknown }[];
    }[] = [];
    const provider = await startOpenAiResponsesModelServer({
      modelId,
      bindError: "Synthetic chat provider failed to bind",
      async onRequest(request, response) {
        let requestText = "";
        for await (const chunk of request) {
          requestText += String(chunk);
        }
        const id = String(++nextResponse);
        if (requestText.includes("You are a context summarization assistant.")) {
          summaryRequests++;
          concurrentCompaction ||= pendingGeneration > 0;
          pendingSummaries++;
          await delay(200);
          pendingSummaries--;
          writeOpenAiResponsesText(response, {
            text: "PI_INTERNAL_SUMMARY",
            messageId: `msg_${id}`,
            responseId: `resp_${id}`,
          });
          return;
        }
        const contextTurn = [...requestText.matchAll(/PI_CONTEXT_PROOF_TURN_(\d+)/g)].at(-1)?.[1];
        if (contextTurn) {
          concurrentCompaction ||= pendingSummaries > 0;
          pendingGeneration++;
          await delay(150);
          pendingGeneration--;
          const input = 15000 * Number(contextTurn);
          writeOpenAiResponsesText(response, {
            text: `PI_CONTEXT_ANSWER_${contextTurn}`,
            messageId: `msg_${id}`,
            responseId: `resp_${id}`,
            usage: { input_tokens: input, output_tokens: 5, total_tokens: input + 5 },
          });
          return;
        }
        if (requestText.includes("PI_OPEN_APP")) {
          const body = JSON.parse(requestText) as NonNullable<typeof appModelRequest> & {
            input?: { type: string }[];
          };
          if (!body.input?.some(({ type }) => type === "function_call_output")) {
            appModelRequest = body;
            writeRestartToolCall(response, "pi-app", "parity__show", {}, Number(id));
            return;
          }
          writeOpenAiResponsesText(response, {
            text: requestText.includes("PI_REVISE_PROOF") ? "PI_FINAL_ANSWER" : "PI_FIRST_DRAFT",
            messageId: `msg_${id}`,
            responseId: `resp_${id}`,
          });
          return;
        }
        if (/PI_FORK_(EARLY|PIVOT|CHECK)/.test(requestText)) {
          if (
            !/PI_FORK_(PIVOT|CHECK)/.test(requestText) &&
            !requestText.includes('"type":"function_call_output"')
          ) {
            writeRestartToolCall(response, "pi-fork-checkpoint", "session_status", {}, Number(id));
            return;
          }
          if (requestText.includes("PI_FORK_CHECK")) {
            forkRequest = requestText;
          }
          writeOpenAiResponsesText(response, {
            text: requestText.includes("PI_FORK_CHECK")
              ? "PI_FORK_INDEPENDENT"
              : requestText.includes("PI_FORK_PIVOT")
                ? "PI_FORK_UNSELECTED_ANSWER"
                : "PI_FORK_BASE_ANSWER",
            messageId: `msg_${id}`,
            responseId: `resp_${id}`,
          });
          return;
        }
        if (requestText.includes("PI_EARLY_RESTART")) {
          earlyRequests++;
          if (earlyRequests === 1) {
            await holdModelAfterText(response, id, "PI_EARLY_PREVIEW");
          } else {
            writeOpenAiResponsesText(response, {
              text: "PI_EARLY_RECOVERED",
              messageId: `msg_${id}`,
              responseId: `resp_${id}`,
            });
          }
          return;
        }
        if (requestText.includes("PI_STEER_OPENING")) {
          if (!steeringInference) {
            steeringInference = true;
            await steerGate.promise;
            writeRestartToolCall(response, "pi-steering", "session_status", {}, Number(id));
          } else {
            writeOpenAiResponsesText(response, {
              text: requestText.includes("PI_STEER_UPDATE")
                ? "PI_STEER_IN_SAME_TURN"
                : "PI_STEER_MISSED",
              messageId: `msg_${id}`,
              responseId: `resp_${id}`,
            });
          }
          return;
        }
        if (requestText.includes("PI_CANCEL_ACTIVE")) {
          pendingPiInference = "waiting";
          await holdModelAfterText(response, id, "Pi preview arrived before inference settled.");
          pendingPiInference = "closed";
          return;
        }
        if (requestText.includes("PI_CHILD_PARK")) {
          const body = JSON.parse(requestText) as {
            model: string;
            tools?: { name: string }[];
            input?: { type: string; name?: string; call_id?: string; output?: unknown }[];
          };
          const toolTranscript = body.input?.filter(
            ({ type }) => type === "function_call" || type === "function_call_output",
          );
          childRequests.push({
            model: body.model,
            authorization: request.headers.authorization,
            tools: body.tools?.map(({ name }) => name),
            toolTranscript,
          });
          if (!toolTranscript?.some(({ type }) => type === "function_call_output")) {
            writeRestartToolCall(response, "pi-child", "pi_durable_wait", {}, Number(id));
            return;
          }
          if (childRequests.length === 2) {
            await holdModelAfterText(response, id, "PI_UNCOMMITTED_BACKGROUND_PREVIEW");
            return;
          }
          if (!toolTranscript.some(({ name }) => name === "pi_proof_record_effect")) {
            writeRestartToolCall(response, "pi-effect", "pi_proof_record_effect", {}, Number(id));
            return;
          }
        }
        const phase = [...requestText.matchAll(/PARENT_CHAT_([1-5])/g)].at(-1)?.[1];
        writeOpenAiResponsesText(response, {
          text: phase ? `PARENT_ANSWER_${phase}` : "PI_CHILD_APPROVED",
          messageId: `msg_${id}`,
          responseId: `resp_${id}`,
        });
      },
    });
    let gateway: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
    let client: Awaited<ReturnType<typeof connectRestartClient>> | undefined;
    let fixtureRoot: string | undefined;

    await runQaGatewayFixture(
      async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), "openclaw-pi-parity-"));
        const pluginPath = join(fixtureRoot, "plugin");
        const workspace = join(fixtureRoot, "workspace");
        const effectPath = join(fixtureRoot, "committed-effects.log");
        await mkdir(workspace);
        await writeFile(
          join(workspace, "AGENTS.md"),
          "Workspace proof marker PI_WORKSPACE_PROOF.\n",
        );
        await writeRestartPlugin(
          pluginPath,
          {
            id: "pi-parity-hooks",
            contracts: { tools: ["pi_proof_record_effect"] },
            activation: { onStartup: true },
            configSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          `import { appendFile } from "node:fs/promises";
          export default {
          id: "pi-parity-hooks",
          register(api) {
            api.registerTool({
              name: "pi_proof_record_effect",
              label: "Record Pi proof effect",
              description: "Record an isolated local proof marker, then wait.",
              parameters: { type: "object", properties: {}, additionalProperties: false },
              async execute(_id, _args, signal) {
                await appendFile(${JSON.stringify(effectPath)}, "committed\\n");
                await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
                return { content: [{ type: "text", text: "committed" }] };
              },
            }, { workspaceAccess: false });
            api.on("before_prompt_build", (event) => event.prompt.includes("PI_OPEN_APP") ? {
              prependContext: "PI_HOOK_PROOF", toolsAllow: ["parity__show", "parity__click"],
            } : undefined);
            api.on("before_agent_finalize", (event) => event.lastAssistantMessage === "PI_FIRST_DRAFT" ? {
              action: "revise", retry: { instruction: "PI_REVISE_PROOF", maxAttempts: 1 },
            } : undefined);
            api.on("after_tool_call", (event) => {
              if (event.toolName === "parity__show") api.logger.info("Pi proof observed App tool settlement");
            });
            api.on("agent_end", (event) => {
              if (JSON.stringify(event.messages).includes("PI_FINAL_ANSWER")) api.logger.info("Pi proof observed agent end");
            });
            api.on("before_compaction", () => api.logger.info("Pi proof observed before compaction"));
            api.on("after_compaction", () => api.logger.info("Pi proof observed after compaction commit"));
          },
        };`,
        );
        const config = createOpenAiResponsesModelConfig({
          baseUrl: provider.baseUrl,
          providerId: "mock-openai",
          modelId,
          reasoning: false,
          toolProfile: "full",
        });
        const providerConfig = config.models!.providers!["mock-openai"]!;
        providerConfig.models.push({
          ...providerConfig.models[0]!,
          id: childModelId,
          name: childModelId,
          contextWindow: 95_000,
          // Open-ended pricing is normalized to Infinity by OpenClaw's provider catalog.
          cost: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            tieredPricing: [{ range: [0], input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }],
          },
        });
        config.agents!.defaults!.models![`mock-openai/${childModelId}`] = {
          agentRuntime: { id: pluginId },
        };
        config.models!.providers!.anthropic = {
          baseUrl: `http://127.0.0.1:${anthropicAddress.port}`,
          apiKey: "fixture-anthropic-token",
          api: "anthropic-messages",
          request: { allowPrivateNetwork: true },
          models: [
            {
              ...providerConfig.models[0]!,
              id: extraModelId,
              name: extraModelId,
              api: "anthropic-messages",
            },
          ],
        };
        config.agents!.defaults!.models![`anthropic/${extraModelId}`] = {
          agentRuntime: { id: pluginId },
        };
        config.agents!.defaults!.workspace = workspace;
        const instance = await createOpenClawTestInstance({
          name: "pi-durable-child",
          config: {
            ...config,
            update: { checkOnStart: false },
            browser: { enabled: false },
            discovery: { mdns: { mode: "off" } },
            logging: { consoleLevel: "debug" },
            messages: { queue: { mode: "steer", debounceMsByChannel: { webchat: 0 } } },
            plugins: {
              ...config.plugins,
              allow: [pluginId, "openai", "anthropic", "pi-parity-hooks"],
              load: { paths: [pluginPath] },
              entries: {
                [pluginId]: { enabled: true },
                "pi-parity-hooks": {
                  enabled: true,
                  hooks: { allowPromptModification: true, allowConversationAccess: true },
                },
              },
            },
            mcp: {
              apps: { enabled: true },
              servers: {
                parity: {
                  command: process.execPath,
                  args: [
                    fileURLToPath(
                      new URL("./fixtures/gateway-pi-durable-mcp.mjs", import.meta.url),
                    ),
                  ],
                },
              },
            },
            tools: {
              ...config.tools,
              allow: [
                "session_status",
                "pi_durable_wait",
                "parity__show",
                "parity__click",
                "pi_proof_record_effect",
              ],
              codeMode: { enabled: false },
            },
          },
          env: {
            ...restartEnv,
            OPENCLAW_NO_RESPAWN: "1",
            OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
          },
          signal,
        });
        gateway = instance;
        const boot = async () => {
          await instance.startGateway();
          client = await connectRestartClient(
            instance,
            {
              onEvent(event) {
                const payload = event.payload as
                  | { runId?: string; state?: string; sessionKey?: string }
                  | undefined;
                if (event.event === "chat.side_result" && payload?.runId) {
                  sideResults.set(payload.runId, JSON.stringify(payload));
                }
                if (
                  event.event === "chat" &&
                  payload?.state === "delta" &&
                  payload.sessionKey &&
                  JSON.stringify(payload).includes("PI_UNCOMMITTED_BACKGROUND_PREVIEW")
                ) {
                  recoveredPreviews.add(payload.sessionKey);
                }
                if (
                  event.event === "chat" &&
                  payload?.state === "delta" &&
                  payload.runId &&
                  JSON.stringify(payload).includes("Pi preview arrived before inference settled.")
                ) {
                  previewRuns.add(payload.runId);
                }
                if (
                  event.event === "chat" &&
                  payload?.state === "delta" &&
                  JSON.stringify(payload).includes("PI_INTERNAL_SUMMARY")
                ) {
                  summaryReachedChat = true;
                }
              },
            },
            signal,
          );
          return client;
        };
        const crash = async () => {
          await instance.crashGateway();
          await client?.stopAndWait();
          client = undefined;
        };
        const parent = "agent:main:dashboard:pi-durable-parent";
        const child = `agent:main:dashboard:${randomUUID()}`;
        const target = { sessionKey: child, agentId: "main" };
        const answerInParent = async (connection: NonNullable<typeof client>, phase: number) => {
          const { runId } = await connection.request<{ runId: string }>("chat.send", {
            sessionKey: parent,
            message: `PARENT_CHAT_${phase}`,
            idempotencyKey: randomUUID(),
          });
          await expect(
            connection.request("agent.wait", { runId, timeoutMs: 15_000 }),
          ).resolves.toMatchObject({ status: "ok" });
          const history = await connection.request<{ messages: { role: string }[] }>(
            "chat.history",
            { sessionKey: parent },
          );
          expect(
            JSON.stringify(history.messages.filter((message) => message.role === "assistant")),
          ).toContain(`PARENT_ANSWER_${phase}`);
        };

        const first = await boot();
        await first.request("sessions.create", { key: parent, agentId: "main" });
        await expect(
          first.request("sessions.create", {
            key: child,
            agentId: "main",
            parentSessionKey: parent,
            spawnDepth: 1,
            model: `mock-openai/${childModelId}`,
            agentRuntime: pluginId,
          }),
        ).resolves.toMatchObject({ key: child });
        const { runId } = await first.request<{ runId: string }>("chat.send", {
          sessionKey: child,
          message: "PI_CHILD_PARK",
          idempotencyKey: randomUUID(),
        });
        expect(
          await first.request("agent.wait", { runId, timeoutMs: 15_000 }),
          instance.logs(),
        ).toMatchObject({ status: "ok" });
        const start = await first.request<{ id: string; state: string }>(
          "pi-durable-child.status",
          target,
        );
        expect(start, JSON.stringify(childRequests)).toMatchObject({ state: "waiting" });
        const { id } = start;
        expect(childRequests).toEqual([
          {
            model: childModelId,
            authorization: "Bearer test-token-placeholder",
            tools: ["parity__show", "pi_durable_wait", "pi_proof_record_effect", "session_status"],
            toolTranscript: [],
          },
        ]);
        await answerInParent(first, 1);
        await crash();

        const second = await boot();
        await expect(second.request("pi-durable-child.status", target)).resolves.toEqual({
          id,
          state: "waiting",
        });
        await answerInParent(second, 2);
        const approval = `durable:${pluginId}:${id}`;
        const approvalCommand = `/approve ${approval} allow-once`;
        const approvalAcknowledgement = `Approval allow-once submitted for ${approval}`;
        const { runId: approvalRunId } = await second.request<{ runId: string }>("chat.send", {
          sessionKey: parent,
          message: approvalCommand,
          idempotencyKey: randomUUID(),
        });
        await expect(
          second.request("agent.wait", { runId: approvalRunId, timeoutMs: 15_000 }),
        ).resolves.toMatchObject({ status: "ok" });
        const approvalHistory = await second.request<{ messages: { role: string }[] }>(
          "chat.history",
          { sessionKey: parent },
        );
        expect(
          JSON.stringify(approvalHistory.messages.filter(({ role }) => role === "assistant")),
          instance
            .logs()
            .split("\n")
            .filter((line) => line.includes("Durable approval"))
            .join("\n"),
        ).toContain(approvalAcknowledgement);
        await crash();
        expect(instance.logs()).not.toContain(`Resuming Pi Durable child ${id}`);
        expect(childRequests).toHaveLength(1);

        const streaming = await boot();
        await vi.waitFor(() => expect(recoveredPreviews.has(child)).toBe(true), {
          timeout: 15_000,
        });
        expect(recoveredPreviews.has(parent)).toBe(false);
        await answerInParent(streaming, 3);
        expect(
          JSON.stringify(await streaming.request("chat.history", { sessionKey: child })),
        ).not.toContain("PI_UNCOMMITTED_BACKGROUND_PREVIEW");
        await crash();

        const executingTool = await boot();
        await vi.waitFor(
          async () => {
            const effect = await readFile(effectPath, "utf8").catch(() => "");
            expect(
              effect,
              JSON.stringify({
                requests: childRequests,
                logs: instance
                  .logs()
                  .split("\n")
                  .filter((line) => /Pi Durable|pi_proof_record_effect/.test(line))
                  .slice(-24),
              }),
            ).toBe("committed\n");
          },
          { timeout: 20_000 },
        );
        await answerInParent(executingTool, 4);
        await crash();

        const third = await boot();
        await vi.waitFor(
          async () => {
            expect(
              await third.request("pi-durable-child.status", target),
              instance
                .logs()
                .split("\n")
                .filter((line) => line.includes("Pi Durable"))
                .join("\n"),
            ).toEqual({
              id,
              state: "completed",
              result: { text: "PI_CHILD_APPROVED" },
            });
          },
          { timeout: 15_000, interval: 250 },
        );
        expect(instance.logs().split(`Resuming Pi Durable child ${id}`)).toHaveLength(4);
        expect(childRequests).toHaveLength(4);
        const resumed = childRequests[1]!;
        expect(resumed).toMatchObject({
          model: childModelId,
          authorization: "Bearer test-token-placeholder",
          toolTranscript: [
            { type: "function_call", name: "pi_durable_wait", call_id: expect.any(String) },
            {
              type: "function_call_output",
              output: expect.stringContaining("Approval granted. Session verified."),
            },
          ],
        });
        expect(resumed.toolTranscript?.[1]?.call_id).toBe(resumed.toolTranscript?.[0]?.call_id);
        expect(childRequests[3]?.toolTranscript).toContainEqual(
          expect.objectContaining({
            type: "function_call_output",
            output: expect.stringContaining("was interrupted and may have partially run"),
          }),
        );
        expect(await readFile(effectPath, "utf8")).toBe("committed\n");
        const history = await third.request("chat.history", { sessionKey: child });
        expect(JSON.stringify(history)).toContain("PI_CHILD_APPROVED");
        expect(JSON.stringify(history)).not.toContain("PI_UNCOMMITTED_BACKGROUND_PREVIEW");
        await answerInParent(third, 5);
        const recoveredParent = await third.request<{
          messages: { role: string; content: unknown }[];
        }>("chat.history", { sessionKey: parent });
        const countMessages = (role: string, text: string) =>
          recoveredParent.messages.filter(
            (message) => message.role === role && JSON.stringify(message.content)?.includes(text),
          ).length;
        expect(countMessages("user", approvalCommand)).toBe(1);
        expect(countMessages("assistant", approvalAcknowledgement)).toBe(1);

        const direct = `agent:main:dashboard:${randomUUID()}`;
        await third.request("sessions.create", {
          key: direct,
          agentId: "main",
          model: `mock-openai/${childModelId}`,
          agentRuntime: pluginId,
        });
        const running = await third.request<{ runId: string }>("chat.send", {
          sessionKey: direct,
          message: "PI_CANCEL_ACTIVE",
          idempotencyKey: randomUUID(),
        });
        await vi.waitFor(
          () =>
            expect(pendingPiInference, instance.logs().split("\n").slice(-25).join("\n")).toBe(
              "waiting",
            ),
          { timeout: 10_000 },
        );
        await vi.waitFor(() => expect(previewRuns.has(running.runId)).toBe(true), {
          timeout: 10_000,
        });
        expect(pendingPiInference).toBe("waiting");
        await expect(
          third.request("chat.abort", { sessionKey: direct, runId: running.runId }),
        ).resolves.toMatchObject({ aborted: true, runIds: [running.runId] });
        await vi.waitFor(
          async () => {
            expect(pendingPiInference).toBe("closed");
            await expect(
              third.request("pi-durable-child.status", { sessionKey: direct, agentId: "main" }),
            ).resolves.toMatchObject({ state: "cancelled" });
          },
          { timeout: 10_000 },
        );
        const app = await third.request<{ runId: string }>("chat.send", {
          sessionKey: direct,
          message: "PI_OPEN_APP",
          idempotencyKey: randomUUID(),
        });
        await expect(
          third.request("agent.wait", { runId: app.runId, timeoutMs: 15_000 }),
        ).resolves.toMatchObject({ status: "ok" });
        expect(JSON.stringify(appModelRequest)).toContain("PI_WORKSPACE_PROOF");
        expect(JSON.stringify(appModelRequest)).toContain("PI_HOOK_PROOF");
        expect(appModelRequest?.tools?.map(({ name }) => name)).toEqual(["parity__show"]);
        const appHistory = await third.request<{
          messages: Array<{ details?: { mcpAppPreview?: { mcpApp?: { viewId?: string } } } }>;
        }>("chat.history", { sessionKey: direct });
        expect(JSON.stringify(appHistory)).toContain("PI_FINAL_ANSWER");
        expect(JSON.stringify(appHistory)).not.toContain("PI_FIRST_DRAFT");
        const viewId = appHistory.messages.flatMap(
          ({ details }) => details?.mcpAppPreview?.mcpApp?.viewId ?? [],
        )[0];
        expect(viewId).toBeDefined();
        const appSession = { sessionKey: direct, agentId: "main" };
        await expect(third.request("mcp.app.discover", appSession)).resolves.toMatchObject({
          servers: [expect.objectContaining({ serverName: "parity" })],
        });
        const opened = await third.request("mcp.app.launch", {
          ...appSession,
          serverName: "parity",
          toolName: "show",
          entrypointType: "global",
        });
        expect(JSON.stringify(opened)).toContain("ui://pi-durable-proof/app");
        const clicked = await third.request("mcp.app.callTool", {
          ...appSession,
          viewId,
          toolName: "click",
        });
        expect(JSON.stringify(clicked)).toContain("Pi Durable App click settled.");
        expect(instance.logs()).toContain("Pi proof observed App tool settlement");
        await vi.waitFor(() => expect(instance.logs()).toContain("Pi proof observed agent end"));

        await third.stopAndWait();
        client = undefined;
        await instance.stopGateway();
        const earlyConnection = await boot();
        const earlyChat = `agent:main:dashboard:${randomUUID()}`;
        await earlyConnection.request("sessions.create", {
          key: earlyChat,
          agentId: "main",
          model: `mock-openai/${childModelId}`,
          agentRuntime: pluginId,
        });
        await earlyConnection.request("chat.send", {
          sessionKey: earlyChat,
          message: "PI_EARLY_RESTART",
          idempotencyKey: randomUUID(),
        });
        await vi.waitFor(
          () => expect(earlyRequests, instance.logs().split("\n").slice(-16).join("\n")).toBe(1),
          { timeout: 15_000 },
        );
        await crash();

        const reopened = await boot();
        await vi.waitFor(
          async () => {
            const recovered = JSON.stringify(
              await reopened.request("chat.history", { sessionKey: earlyChat }),
            );
            expect(
              recovered,
              instance
                .logs()
                .split("\n")
                .filter((line) => /Pi Durable|recover/i.test(line))
                .slice(-20)
                .join("\n"),
            ).toContain("PI_EARLY_RECOVERED");
            expect(recovered.split("PI_EARLY_RECOVERED")).toHaveLength(2);
            expect(recovered).not.toContain("PI_EARLY_PREVIEW");
          },
          { timeout: 20_000 },
        );
        expect(earlyRequests).toBe(2);

        await expect(
          reopened.request("mcp.app.view", { ...appSession, viewId }),
        ).resolves.toMatchObject({
          html: expect.stringContaining("Pi Durable App"),
          messageSupported: false,
        });

        const forkSource = `agent:main:dashboard:${randomUUID()}`;
        await reopened.request("sessions.create", {
          key: forkSource,
          agentId: "main",
          model: `mock-openai/${childModelId}`,
          agentRuntime: pluginId,
        });
        for (const input of ["PI_FORK_EARLY", "PI_FORK_PIVOT"]) {
          const { runId: forkSourceRunId } = await reopened.request<{ runId: string }>(
            "chat.send",
            {
              sessionKey: forkSource,
              message: input,
              idempotencyKey: randomUUID(),
            },
          );
          await expect(
            reopened.request("agent.wait", { runId: forkSourceRunId, timeoutMs: 15_000 }),
          ).resolves.toMatchObject({ status: "ok" });
        }
        const sourceHistory = await reopened.request<{
          messages: { role: string; content: unknown; __openclaw?: { id?: string } }[];
        }>("chat.history", { sessionKey: forkSource });
        const pivot = sourceHistory.messages.find(
          ({ role, content }) =>
            role === "user" && JSON.stringify(content).includes("PI_FORK_PIVOT"),
        )?.["__openclaw"]?.id;
        expect(pivot).toBeDefined();
        const branch = await reopened.request<{ sessionKey: string; editorText?: string }>(
          "sessions.fork",
          { sessionKey: forkSource, entryId: pivot, agentId: "main" },
        );
        expect(branch.editorText).toContain("PI_FORK_PIVOT");
        const { runId: branchRunId } = await reopened.request<{ runId: string }>("chat.send", {
          sessionKey: branch.sessionKey,
          message: "PI_FORK_CHECK",
          idempotencyKey: randomUUID(),
        });
        expect(
          await reopened.request("agent.wait", { runId: branchRunId, timeoutMs: 15_000 }),
          instance
            .logs()
            .split("\n")
            .filter((line) => /Pi Durable|failed/i.test(line))
            .slice(-12)
            .join("\n"),
        ).toMatchObject({ status: "ok" });
        expect(forkRequest).toContain("PI_FORK_BASE_ANSWER");
        expect(forkRequest).toContain('"type":"function_call_output"');
        expect(forkRequest).toContain("call_pi-fork-checkpoint");
        expect(forkRequest).not.toContain("PI_FORK_UNSELECTED_ANSWER");
        expect(forkRequest).not.toContain("PI_FORK_PIVOT");

        const steerChat = `agent:main:dashboard:${randomUUID()}`;
        const piDirectory = join(instance.stateDir, pluginId);
        const originalDatabases = await readdir(piDirectory);
        await reopened.request("sessions.create", {
          key: steerChat,
          agentId: "main",
          model: `mock-openai/${childModelId}`,
          agentRuntime: pluginId,
        });
        const { runId: steerOwner } = await reopened.request<{ runId: string }>("chat.send", {
          sessionKey: steerChat,
          message: "PI_STEER_OPENING",
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        await vi.waitFor(
          () =>
            expect(steeringInference, instance.logs().split("\n").slice(-12).join("\n")).toBe(true),
          { timeout: 12_000 },
        );
        const steeringDb = (await readdir(piDirectory)).find(
          (file) => file.endsWith(".sqlite") && !originalDatabases.includes(file),
        );
        expect(steeringDb).toBeDefined();
        await reopened.request("chat.send", {
          sessionKey: steerChat,
          message: "PI_STEER_UPDATE",
          deliver: false,
          queueMode: "steer",
          idempotencyKey: randomUUID(),
        });
        try {
          await vi.waitFor(
            () => {
              const db = new DatabaseSync(join(piDirectory, steeringDb!), { readOnly: true });
              try {
                expect(
                  db
                    .prepare(
                      "SELECT status FROM submissions WHERE json_extract(request_id, '$') LIKE 'openclaw.steer.%'",
                    )
                    .get(),
                  instance
                    .logs()
                    .split("\n")
                    .filter((line) => /steer|admission|register/i.test(line))
                    .slice(-20)
                    .join("\n"),
                ).toMatchObject({ status: "queued" });
              } finally {
                db.close();
              }
            },
            { timeout: 10_000 },
          );
        } finally {
          steerGate.resolve();
        }
        await expect(
          reopened.request("agent.wait", { runId: steerOwner, timeoutMs: 15_000 }),
        ).resolves.toMatchObject({ status: "ok" });
        const settledSteering = new DatabaseSync(join(piDirectory, steeringDb!), {
          readOnly: true,
        });
        try {
          const submissions = settledSteering
            .prepare(`
            SELECT json_extract(request_id, '$') AS requestId,
                   status, json_extract(record, '$.answer') AS answer
            FROM submissions
          `)
            .all();
          const origin = submissions.find(({ requestId }) => requestId === steerOwner);
          expect(origin).toMatchObject({ status: "done", answer: expect.any(Number) });
          expect(
            submissions.find(({ requestId }) => String(requestId).startsWith("openclaw.steer.")),
          ).toMatchObject({ status: "done", answer: origin?.answer });
        } finally {
          settledSteering.close();
        }
        await vi.waitFor(async () => {
          const { messages } = await reopened.request<{
            messages: { role: string; content: unknown }[];
          }>("chat.history", { sessionKey: steerChat });
          const result = JSON.stringify(messages.filter(({ role }) => role === "assistant"));
          expect(result).toContain("PI_STEER_IN_SAME_TURN");
          expect(result).not.toContain("PI_STEER_MISSED");
          expect(
            messages.some(
              ({ role, content }) =>
                role === "user" && JSON.stringify(content).includes("PI_STEER_UPDATE"),
            ),
          ).toBe(true);
        });

        const longChat = `agent:main:dashboard:${randomUUID()}`;
        await reopened.request("sessions.create", {
          key: longChat,
          agentId: "main",
          model: `mock-openai/${childModelId}`,
          agentRuntime: pluginId,
        });
        for (let turn = 1; turn <= 4; turn++) {
          const { runId: longRunId } = await reopened.request<{ runId: string }>("chat.send", {
            sessionKey: longChat,
            message: `PI_CONTEXT_PROOF_TURN_${turn}\n${"Synthetic archive entry for testing context compaction. ".repeat(875)}`,
            idempotencyKey: randomUUID(),
          });
          await expect(
            reopened.request("agent.wait", { runId: longRunId, timeoutMs: 15_000 }),
          ).resolves.toMatchObject({ status: "ok" });
        }
        const longHistory = JSON.stringify(
          await reopened.request("chat.history", { sessionKey: longChat }),
        );
        expect(longHistory).toContain("PI_CONTEXT_ANSWER_4");
        expect(longHistory).not.toContain("PI_INTERNAL_SUMMARY");
        expect(concurrentCompaction).toBe(true);
        expect(summaryReachedChat).toBe(false);
        expect(instance.logs()).toContain("Pi proof observed before compaction");
        expect(instance.logs()).toContain("Pi proof observed after compaction commit");
        const manualChat = `agent:main:dashboard:${randomUUID()}`;
        await reopened.request("sessions.create", {
          key: manualChat,
          agentId: "main",
          model: `mock-openai/${childModelId}`,
          agentRuntime: pluginId,
        });
        // A manual cut still has to leave Pi's recent context intact. Give it a
        // fresh, eligible prefix after the separate automatic-compaction case.
        for (let turn = 1; turn <= 4; turn++) {
          const { runId: seedRunId } = await reopened.request<{ runId: string }>("chat.send", {
            sessionKey: manualChat,
            message: `PI_MANUAL_COMPACT_SEED_${turn}\n${"History retained for the explicit compaction boundary proof. ".repeat(850)}`,
            idempotencyKey: randomUUID(),
          });
          await expect(
            reopened.request("agent.wait", { runId: seedRunId, timeoutMs: 15_000 }),
          ).resolves.toMatchObject({ status: "ok" });
        }
        const autoSummaries = summaryRequests;
        const readDatabases = async () =>
          (await readdir(join(instance.stateDir, pluginId))).filter((name) =>
            name.endsWith(".sqlite"),
          );
        const beforeReset = await readDatabases();
        const { runId: compactRunId } = await reopened.request<{ runId: string }>("chat.send", {
          sessionKey: manualChat,
          message: "/compact Preserve the context proof markers.",
          idempotencyKey: randomUUID(),
        });
        await expect(
          reopened.request("agent.wait", { runId: compactRunId, timeoutMs: 15_000 }),
        ).resolves.toMatchObject({ status: "ok" });
        const compactedHistory = JSON.stringify(
          await reopened.request("chat.history", { sessionKey: manualChat }),
        );
        expect(
          summaryRequests,
          JSON.stringify({
            lastMessage: compactedHistory.slice(-1600),
            logs: instance
              .logs()
              .split("\n")
              .filter((line) => /compact|Pi Durable/.test(line))
              .slice(-18),
          }),
        ).toBeGreaterThan(autoSummaries);
        expect(compactedHistory).not.toContain("PI_INTERNAL_SUMMARY");
        expect(
          instance.logs().split("Pi proof observed after compaction commit").length,
        ).toBeGreaterThan(2);
        await reopened.request("sessions.reset", {
          key: longChat,
          agentId: "main",
          reason: "reset",
        });
        await vi.waitFor(
          async () => {
            expect(await readDatabases()).toHaveLength(beforeReset.length - 1);
          },
          { timeout: 10_000 },
        );

        const altChat = `agent:main:dashboard:${randomUUID()}`;
        await reopened.request("sessions.create", {
          key: altChat,
          agentId: "main",
          model: `anthropic/${extraModelId}`,
          agentRuntime: pluginId,
        });
        const { runId: altRunId } = await reopened.request<{ runId: string }>("chat.send", {
          sessionKey: altChat,
          message: "PI_ANTHROPIC_ROUTE",
          idempotencyKey: randomUUID(),
        });
        expect(
          await reopened.request("agent.wait", { runId: altRunId, timeoutMs: 15_000 }),
          instance.logs().split("\n").slice(-16).join("\n"),
        ).toMatchObject({ status: "ok" });
        expect(anthropicRequest?.apiKey).toBe("fixture-anthropic-token");
        expect(anthropicRequest?.body).toContain("PI_ANTHROPIC_ROUTE");
        const alternateHistory = JSON.stringify(
          await reopened.request("chat.history", { sessionKey: altChat }),
        );
        expect(alternateHistory).toContain("ANTHROPIC_PI_REPLY");
        const { runId: sideId } = await reopened.request<{ runId: string }>("chat.send", {
          sessionKey: altChat,
          message: "/btw PI_ANTHROPIC_SIDE_QUESTION",
          idempotencyKey: randomUUID(),
        });
        await vi.waitFor(
          () =>
            expect(
              sideResults.get(sideId),
              instance
                .logs()
                .split("\n")
                .filter((line) => /side question|commands-btw/.test(line))
                .slice(-10)
                .join("\n"),
            ).toContain("ANTHROPIC_PI_SIDE_REPLY"),
          {
            timeout: 15_000,
          },
        );
        expect(anthropicRequest?.body).toContain("ANTHROPIC_PI_REPLY");
        expect(
          JSON.stringify(await reopened.request("chat.history", { sessionKey: altChat })),
        ).not.toContain("ANTHROPIC_PI_SIDE_REPLY");
        const beforeDelete = await readDatabases();
        await reopened.request("sessions.delete", { key: altChat, agentId: "main" });
        expect(await readDatabases()).toHaveLength(beforeDelete.length - 1);
      },
      () => client?.stopAndWait(),
      () => gateway?.cleanup(),
      () => {
        steerGate.resolve();
        return provider.close();
      },
      async () => {
        anthropic.closeAllConnections();
        await new Promise<void>((resolve) => {
          anthropic.close(() => resolve());
        });
      },
      () => fixtureRoot && rm(fixtureRoot, { recursive: true, force: true }),
    );
  },
);
