import fs from "node:fs/promises";
import path from "node:path";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { createLobsterTool } from "./lobster-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const record = createRequireRecord("record", "expected-label-record");
afterEach(() => vi.unstubAllEnvs());

function registeredTool(
  directory: string,
  backend: "files" | "sqlite",
  sessionKey = "agent:main:review",
) {
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  plugin.register(
    createTestPluginApi({ pluginConfig: { directory, backend, history: false }, registerTool }),
  );
  const factory = registerTool.mock.calls[0]?.[0];
  if (!factory || typeof factory !== "object" || !("create" in factory)) {
    throw new Error("expected a versioned Lobster tool factory");
  }
  const ctx: OpenClawPluginToolContext<2> = {
    agentId: "main",
    sessionKey,
    sessionId: crypto.randomUUID(),
    sandboxed: false,
    assertInvocationCurrent() {},
  };
  const tool = factory.create(ctx);
  if (!tool || Array.isArray(tool)) {
    throw new Error("expected one Lobster tool");
  }
  return async (params: Record<string, unknown>) =>
    record((await tool.execute("call", params)).details, "envelope");
}

function promptHook(directory: string, backend: "files" | "sqlite") {
  const on = vi.fn<OpenClawPluginApi["on"]>();
  const api = createTestPluginApi({ pluginConfig: { directory, backend, history: false }, on });
  plugin.register(api);
  const registration = on.mock.calls.find(([name]) => name === "before_prompt_build");
  if (!registration) {
    throw new Error("expected pending-run prompt hook");
  }
  // The runtime name selects this member of the generic registration contract.
  return registration[1] as Parameters<typeof api.on<"before_prompt_build">>[1];
}

function output(envelope: Record<string, unknown>) {
  expect(envelope.ok).toBe(true);
  if (!Array.isArray(envelope.output)) {
    throw new Error("expected output array");
  }
  return envelope.output[0];
}

function pendingWait(envelope: Record<string, unknown>) {
  const run = record(output(envelope), "run");
  if (!Array.isArray(run.pendingWaits)) {
    throw new Error("expected pending waits");
  }
  return record(run.pendingWaits[0], "wait");
}

function token(envelope: Record<string, unknown>) {
  const input = record(envelope.requiresInput, "input request");
  if (typeof input.resumeToken !== "string") {
    throw new Error("expected resume token");
  }
  return input.resumeToken;
}

describe.each(["files", "sqlite"] as const)(
  "durable Lobster through the registered tool (%s)",
  (backend) => {
    it("rediscovers saved reviews after a new host session and resumes the same run once", async () => {
      const directory = tempDirs.make("openclaw-lobster-durable-");
      const file = path.join(directory, "review.lobster");
      const schema = {
        type: "object",
        properties: { feedback: { type: "string" } },
        required: ["feedback"],
      };
      const workflow = {
        steps: [
          { id: "prepare", pipeline: "state.set prepared", stdin: { draft: "original" } },
          {
            id: "review",
            input: { prompt: "Review draft?", responseSchema: schema, defaults: { feedback: "" } },
          },
          {
            id: "publish",
            pipeline: "state.get prepared",
            approval: { prompt: "Publish?", items: ["draft"] },
          },
          { id: "finish", pipeline: "state.get prepared" },
        ],
      };
      await fs.writeFile(file, JSON.stringify(workflow));
      const first = await registeredTool(
        directory,
        backend,
      )({ action: "run", pipeline: file, callerId: "spoofed" });
      expect(first).toMatchObject({ ok: true, status: "needs_input", runId: expect.any(String) });
      const runId = first.runId;
      // A new registration has no retained engine session or old host context.
      const restarted = registeredTool(directory, backend);
      expect(output(await restarted({ action: "list", status: "waiting" }))).toMatchObject({
        runs: [{ id: runId, status: "waiting" }],
        nextCursor: null,
      });
      const hook = promptHook(directory, backend);
      const hookEvent = { prompt: "Continue", messages: [] };
      const hookContext = {
        agentId: "main",
        sessionKey: "agent:main:review",
        sessionId: crypto.randomUUID(),
        toolAuthority: {
          fingerprint: "current",
          allows: (name: string) => name === "lobster",
          assertActive() {},
        },
        hookInvocation: { assertActive() {} },
      };
      const notice = await hook(hookEvent, hookContext);
      expect(notice).toMatchObject({ appendContext: expect.stringContaining(String(runId)) });
      expect(notice).not.toHaveProperty("appendSystemContext");
      expect(notice).not.toHaveProperty("prependSystemContext");
      expect(notice?.appendContext).not.toContain("Review draft?");
      expect(
        await hook(hookEvent, { ...hookContext, sessionKey: "agent:main:other" }),
      ).toBeUndefined();
      expect(await hook(hookEvent, { ...hookContext, sessionKey: undefined })).toBeUndefined();
      expect(await hook(hookEvent, { ...hookContext, sandboxed: true })).toBeUndefined();
      expect(
        await hook(hookEvent, {
          ...hookContext,
          toolAuthority: { ...hookContext.toolAuthority, allows: () => false },
        }),
      ).toBeUndefined();
      const status = await restarted({ action: "status", runId });
      expect(output(status)).toMatchObject({ historyEnabled: false });
      const wait = pendingWait(status);
      const review = await restarted({ action: "review", waitId: wait.id });
      expect(output(review)).toMatchObject({
        id: wait.id,
        revision: wait.revision,
        runId,
        request: {
          kind: "input",
          prompt: "Review draft?",
          responseSchema: schema,
          defaults: { feedback: "" },
          subject: { draft: "original" },
        },
      });
      const foreign = registeredTool(directory, backend, "agent:main:other");
      expect(output(await foreign({ action: "list", callerId: "spoofed" }))).toEqual({
        runs: [],
        nextCursor: null,
      });
      expect(output(await foreign({ action: "status", runId }))).toBeNull();
      expect(output(await foreign({ action: "review", waitId: wait.id }))).toBeNull();
      expect(
        await foreign({
          action: "resume",
          waitId: wait.id,
          expectedRevision: wait.revision,
          cancel: true,
        }),
      ).toMatchObject({ ok: false, error: { type: "wait_conflict" } });
      expect(
        await restarted({
          action: "resume",
          waitId: wait.id,
          expectedRevision: Number(wait.revision) + 1,
          cancel: true,
        }),
      ).toMatchObject({ ok: false, error: { type: "wait_conflict" } });
      expect(
        await restarted({
          action: "resume",
          waitId: wait.id,
          expectedRevision: wait.revision,
          responseJson: '{"feedback":123}',
        }),
      ).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/schema validation/) },
      });
      expect(output(await restarted({ action: "review", waitId: wait.id }))).toMatchObject({
        revision: wait.revision,
      });
      workflow.steps[0].stdin = { draft: "changed" };
      await fs.writeFile(file, JSON.stringify(workflow));
      const second = await restarted({
        action: "resume",
        waitId: wait.id,
        expectedRevision: wait.revision,
        responseJson: '{"feedback":"Keep it"}',
      });
      expect(second).toMatchObject({ ok: true, status: "needs_approval", runId });
      const approval = pendingWait(await restarted({ action: "status", runId }));
      expect(output(await restarted({ action: "review", waitId: approval.id }))).toMatchObject({
        request: { kind: "approval", prompt: "Publish?", items: ["draft"] },
      });
      expect(
        await restarted({
          action: "resume",
          waitId: approval.id,
          expectedRevision: approval.revision,
          approve: true,
        }),
      ).toMatchObject({
        ok: true,
        runId,
        status: "ok",
        output: [{ draft: "original" }],
      });
      expect(output(await restarted({ action: "status", runId }))).toMatchObject({
        status: "completed",
        pendingWaits: [],
      });
      expect(
        await restarted({
          action: "resume",
          waitId: wait.id,
          expectedRevision: wait.revision,
          cancel: true,
        }),
      ).toMatchObject({ ok: false, error: { type: "wait_conflict" } });
      expect((await fs.readdir(directory)).filter((name) => name.startsWith(".session-"))).toEqual(
        [],
      );
    });

    it("keeps an oversized question discoverable without repeating the workflow", async () => {
      const directory = tempDirs.make("openclaw-lobster-large-review-");
      const file = path.join(directory, "large.lobster");
      const subject = { draft: "x".repeat(4000) };
      await fs.writeFile(
        file,
        JSON.stringify({
          steps: [
            {
              id: "review",
              stdin: subject,
              input: { prompt: "Review?", responseSchema: { type: "string" } },
            },
          ],
        }),
      );
      const first = await registeredTool(
        directory,
        backend,
      )({ action: "run", pipeline: file, maxStdoutBytes: 1024 });
      expect(first).toMatchObject({
        ok: false,
        runId: expect.any(String),
        error: { type: "result_too_large" },
      });
      const restarted = registeredTool(directory, backend);
      const wait = pendingWait(await restarted({ action: "status", runId: first.runId }));
      expect(
        await restarted({ action: "review", waitId: wait.id, maxStdoutBytes: 1024 }),
      ).toMatchObject({ ok: false, runId: first.runId, error: { type: "result_too_large" } });
      expect(output(await restarted({ action: "review", waitId: wait.id }))).toMatchObject({
        request: { subject },
      });
      expect(
        await restarted({
          action: "resume",
          waitId: wait.id,
          expectedRevision: wait.revision,
          cancel: true,
        }),
      ).toMatchObject({ ok: true, status: "cancelled", runId: first.runId });
    });
  },
);

it("preserves legacy bearer resumes without silently adopting their caller identity", async () => {
  const directory = tempDirs.make("openclaw-lobster-legacy-");
  vi.stubEnv("LOBSTER_STATE_DIR", directory);
  const first = record(
    (
      await createLobsterTool().execute("legacy", {
        action: "run",
        pipeline: 'ask --prompt "First?" | ask --prompt "Second?"',
      })
    ).details,
    "legacy envelope",
  );
  expect(first.runId).toBeUndefined();
  const registered = registeredTool(directory, "files");
  const second = await registered({
    action: "resume",
    token: token(first),
    responseJson: '{"decision":"approve"}',
  });
  expect(second).toMatchObject({ ok: true, status: "needs_input", runId: expect.any(String) });
  expect(output(await registered({ action: "list" }))).toEqual({ runs: [], nextCursor: null });
  expect(output(await registered({ action: "status", runId: second.runId }))).toBeNull();
  expect(await registered({ action: "resume", token: token(second), cancel: true })).toMatchObject({
    ok: true,
    status: "cancelled",
  });
});
