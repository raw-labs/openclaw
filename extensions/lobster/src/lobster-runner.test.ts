import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddedLobsterRunner,
  resolveLobsterCwd,
  type LobsterRunnerParams,
} from "./lobster-runner.js";

type RuntimeLoader = NonNullable<
  NonNullable<Parameters<typeof createEmbeddedLobsterRunner>[0]>["loadRuntime"]
>;
type Runtime = Awaited<ReturnType<RuntimeLoader>>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const success = {
  ok: true,
  status: "ok" as const,
  output: [],
  requiresApproval: null,
};

async function createWorkflow() {
  const cwd = tempDirs.make("openclaw-lobster-runner-");
  const filePath = path.join(cwd, "workflow.lobster");
  await fs.writeFile(filePath, "steps: []\n", "utf8");
  return { cwd, filePath };
}

const ctx = expect.objectContaining({
  cwd: process.cwd(),
  mode: "tool",
  signal: expect.any(AbortSignal),
});

it("resolves relative Lobster paths inside the repo root", () => {
  const relative = "extensions/lobster";
  expect(resolveLobsterCwd(relative)).toBe(path.resolve(process.cwd(), relative));
});

describe("createEmbeddedLobsterRunner", () => {
  const runRequest = vi.fn<Runtime["runToolRequest"]>();
  const resumeRequest = vi.fn<Runtime["resumeToolRequest"]>();
  const close = vi.fn(async () => {});
  const openStoreSession = vi.fn<Runtime["openStoreSession"]>();
  const loadRuntime = vi.fn().mockResolvedValue({
    openStoreSession,
    runToolRequest: runRequest,
    resumeToolRequest: resumeRequest,
  });
  let runner: ReturnType<typeof createEmbeddedLobsterRunner>;
  const run = (overrides: Partial<LobsterRunnerParams> = {}) =>
    runner.run({
      action: "run",
      pipeline: "exec --json=true echo hi",
      cwd: process.cwd(),
      timeoutMs: 2000,
      maxStdoutBytes: 4096,
      ...overrides,
    });
  beforeEach(() => {
    runRequest.mockReset();
    resumeRequest.mockReset();
    loadRuntime.mockClear();
    close.mockClear();
    openStoreSession.mockReset().mockResolvedValue({ close });
    runner = createEmbeddedLobsterRunner({ loadRuntime });
  });

  it("bounds the model-visible result for an embedded workflow request", async () => {
    runRequest.mockResolvedValue({
      ...success,
      output: Array.from({ length: 115 }, () => ({ a: 1 })),
    });
    const { cwd, filePath } = await createWorkflow();
    expect(await run({ pipeline: filePath, cwd, maxStdoutBytes: 1024 })).toMatchObject({
      ok: false,
      error: { type: "result_too_large" },
    });
  });

  it("runs inline pipelines with file-like arguments through the embedded runtime", async () => {
    const raw = { ...success, protocolVersion: 1 };
    runRequest.mockResolvedValue({ ...raw, output: [{ hello: "world" }] });
    const pipeline = "exec --json=true cat data.json";
    const envelope = await run({ pipeline });
    expect(runRequest).toHaveBeenCalledExactlyOnceWith({ pipeline, ctx });
    expect(envelope).toEqual({ ...success, output: [{ hello: "world" }] });
  });

  it("surfaces missing workflow path errors", async () => {
    const cwd = tempDirs.make("openclaw-lobster-runner-");
    await expect(run({ pipeline: "missing.lobster", cwd })).rejects.toMatchObject({
      code: "ENOENT",
      path: path.join(cwd, "missing.lobster"),
    });
    expect(runRequest).not.toHaveBeenCalled();
  });

  it("returns a parse error when workflow args are invalid JSON", async () => {
    const { cwd } = await createWorkflow();
    await expect(run({ pipeline: "workflow.lobster", argsJson: "{bad", cwd })).rejects.toThrow(
      /JSON|Unexpected/,
    );
    expect(runRequest).not.toHaveBeenCalled();
  });

  it("forwards approvalId through resume when token is absent", async () => {
    resumeRequest.mockResolvedValue(success);
    await run({ action: "resume", pipeline: undefined, approvalId: "dbc98d05", approve: true });
    expect(resumeRequest).toHaveBeenCalledExactlyOnceWith({
      approvalId: "dbc98d05",
      approved: true,
      ctx,
    });
  });

  it("loads the embedded runtime once per runner", async () => {
    runRequest.mockResolvedValue(success);
    resumeRequest.mockResolvedValue({ ...success, status: "cancelled" });
    await run();
    await run({ action: "resume", pipeline: undefined, token: "resume-token", approve: false });
    expect(loadRuntime).toHaveBeenCalledTimes(1);
  });

  it.each<[Partial<LobsterRunnerParams>, RegExp]>([
    [{ action: "run", pipeline: undefined }, /pipeline required/],
    [{ token: undefined, approve: true }, /token, approvalId, or waitId required/],
    [{}, /exactly one/],
    [{ responseJson: "{bad" }, /JSON|Unexpected/],
    [{ approve: true, responseJson: "null" }, /exactly one/],
    [{ cancel: false }, /cancel must be true/],
  ])("rejects invalid arguments before executing a workflow: %j", async (params, error) => {
    await expect(run({ action: "resume", token: "resume-token", ...params })).rejects.toThrow(
      error,
    );
    expect(runRequest).not.toHaveBeenCalled();
    expect(resumeRequest).not.toHaveBeenCalled();
  });

  it.each(["persistence_error", "persistence_outcome_unknown"])(
    "preserves structured %s results for recovery",
    async (type) => {
      runRequest.mockResolvedValue({
        ok: false,
        runId: "run-123",
        error: {
          type,
          message: "Storage outcome requires inspection",
          runId: "run-123",
          operationId: "operation-456",
        },
      });
      expect(await run()).toEqual({
        ok: false,
        runId: "run-123",
        error: {
          type,
          message: "Storage outcome requires inspection",
          runId: "run-123",
          operationId: "operation-456",
        },
      });
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds an oversized persistence error without losing its recovery identifiers", async () => {
    runRequest.mockResolvedValue({
      ok: false,
      error: {
        type: "persistence_outcome_unknown",
        message: "private diagnostic".repeat(1000),
        runId: "run-123",
        operationId: "operation-456",
      },
    });
    const result = await run({ maxStdoutBytes: 1024 });
    expect(result).toMatchObject({
      ok: false,
      error: {
        type: "persistence_outcome_unknown",
        runId: "run-123",
        operationId: "operation-456",
      },
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(1024);
  });

  it("rechecks host authority after opening storage before executing a workflow", async () => {
    let current = true;
    openStoreSession.mockImplementation(async () => {
      current = false;
      return { close };
    });
    runner = createEmbeddedLobsterRunner({
      loadRuntime,
      assertCurrent() {
        if (!current) {
          throw new Error("invocation closed");
        }
      },
    });
    await expect(run()).rejects.toThrow("invocation closed");
    expect(runRequest).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("joins an aborted executor before closing its store and preserves its settlement", async () => {
    vi.useFakeTimers();
    try {
      let began!: () => void;
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      let settle!: (envelope: Awaited<ReturnType<Runtime["runToolRequest"]>>) => void;
      let signal: AbortSignal | undefined;
      runRequest.mockImplementation(({ ctx: context }) => {
        signal = context?.signal;
        began();
        return new Promise((resolve) => {
          settle = resolve;
        });
      });
      const pending = run({ timeoutMs: 200 });
      await started;
      await vi.advanceTimersByTimeAsync(200);
      expect(signal?.aborted).toBe(true);
      expect(close).not.toHaveBeenCalled();
      settle({
        ok: false,
        error: {
          type: "persistence_outcome_unknown",
          message: "Inspect before retrying",
          runId: "run-123",
          operationId: "operation-456",
        },
      });
      expect(await pending).toMatchObject({
        error: {
          type: "persistence_outcome_unknown",
          runId: "run-123",
          operationId: "operation-456",
        },
      });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
