import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";

export type LobsterStoreOptions = {
  directory?: string;
  backend?: "files" | "sqlite";
  history?: boolean;
};

type LobsterInputRequest = {
  type?: "input_request";
  prompt: string;
  responseSchema: unknown;
  defaults?: unknown;
  subject?: unknown;
  resumeToken?: string;
};

type LobsterError = { type?: string; message: string; runId?: string; operationId?: string };
export type LobsterEnvelope = {
  runId?: string;
  ok: boolean;
  status?: "ok" | "needs_approval" | "needs_input" | "cancelled";
  output?: unknown[];
  requiresApproval?: {
    type?: "approval_request";
    prompt: string;
    items: unknown[];
    preview?: string;
    resumeToken?: string;
    approvalId?: string;
  } | null;
  requiresInput?: LobsterInputRequest | null;
  error?: LobsterError;
};

type RunStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";
export type LobsterRunnerParams = {
  action: "run" | "resume" | "list" | "status" | "review";
  pipeline?: string;
  argsJson?: string;
  token?: string;
  approvalId?: string;
  waitId?: string;
  expectedRevision?: number;
  runId?: string;
  status?: RunStatus;
  after?: string;
  limit?: number;
  approve?: boolean;
  responseJson?: string;
  cancel?: boolean;
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
};

type StoreSession = { close: () => Promise<void> };
type EmbeddedToolContext = {
  storeSession?: StoreSession;
  runMetadata?: { callerId: string };
  cwd?: string;
  env?: Record<string, string | undefined>;
  mode?: "tool" | "human" | "sdk";
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  signal?: AbortSignal;
  assertInvocationCurrent?: () => void;
};

// @clawdbot/lobster/core loads dynamically so its SQLite worker stays in the plugin dependency.
// These are the consumed public core contracts; no private engine modules are imported.
type EmbeddedToolRuntime = {
  openStoreSession: (
    options: LobsterStoreOptions & {
      trackRuns: boolean;
      env: Record<string, string | undefined>;
      signal: AbortSignal;
    },
  ) => Promise<StoreSession>;
  runToolRequest: (params: {
    pipeline?: string;
    filePath?: string;
    args?: Record<string, unknown>;
    ctx?: EmbeddedToolContext;
  }) => Promise<LobsterEnvelope>;
  resumeToolRequest: (params: {
    token?: string;
    approvalId?: string;
    waitId?: string;
    expectedRevision?: number;
    approved?: boolean;
    response?: unknown;
    cancel?: boolean;
    ctx?: EmbeddedToolContext;
  }) => Promise<LobsterEnvelope>;
  listRuns: (params: {
    status?: RunStatus;
    after?: string;
    limit?: number;
    ctx: EmbeddedToolContext;
  }) => Promise<{
    runs: Array<{ id: string; status: RunStatus }>;
    nextCursor: string | null;
  }>;
  getRun: (params: { runId: string; ctx: EmbeddedToolContext }) => Promise<unknown>;
  getWait: (params: {
    waitId: string;
    ctx: EmbeddedToolContext;
  }) => Promise<{ runId: string } | null>;
};

const workflowExts = new Set([".lobster", ".yaml", ".yml", ".json"]);

export function resolveLobsterCwd(cwdRaw: unknown): string {
  if (typeof cwdRaw !== "string" || !cwdRaw.trim()) {
    return process.cwd();
  }
  const cwd = cwdRaw.trim();
  if (path.isAbsolute(cwd)) {
    throw new Error("cwd must be a relative path");
  }
  const base = process.cwd();
  const resolved = path.resolve(base, cwd);
  if (!isPathInside(base, resolved)) {
    throw new Error("cwd must stay within the gateway working directory");
  }
  return resolved;
}

function createLimitedSink(maxBytes: number, label: "stdout" | "stderr") {
  let bytes = 0;
  return new Writable({
    write(chunk, _encoding, callback) {
      bytes += Buffer.byteLength(String(chunk), "utf8");
      callback(
        bytes > maxBytes ? new Error(`lobster ${label} exceeded maxStdoutBytes`) : undefined,
      );
    },
  });
}

function normalizeEnvelope(envelope: LobsterEnvelope, maxBytes: number): LobsterEnvelope {
  const normalized: LobsterEnvelope = envelope.ok
    ? {
        ...(envelope.runId ? { runId: envelope.runId } : {}),
        ok: true,
        status: envelope.status ?? "ok",
        output: envelope.output ?? [],
        requiresApproval: envelope.requiresApproval
          ? { ...envelope.requiresApproval, type: "approval_request" }
          : null,
        ...(envelope.requiresInput
          ? { requiresInput: { ...envelope.requiresInput, type: "input_request" } }
          : {}),
      }
    : envelope;
  if (Buffer.byteLength(JSON.stringify(normalized, null, 2), "utf8") > maxBytes) {
    if (!envelope.ok && envelope.error) {
      return {
        ...envelope,
        error: {
          ...envelope.error,
          message:
            envelope.error.message.slice(0, Math.floor((maxBytes - 512) / 4)) + " [truncated]",
        },
      };
    }
    return {
      ok: false,
      ...(envelope.runId ? { runId: envelope.runId } : {}),
      error: {
        type: "result_too_large",
        message:
          "Lobster result exceeded maxStdoutBytes. Saved waits remain pending; use status and review with a larger output limit. Do not repeat the workflow to recover its output.",
        ...(envelope.runId ? { runId: envelope.runId } : {}),
      },
    };
  }
  return normalized;
}

async function detectWorkflowFile(candidate: string, cwd: string) {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.includes("|") || !workflowExts.has(path.extname(trimmed).toLowerCase())) {
    return null;
  }
  const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  try {
    if (!(await stat(resolved)).isFile()) {
      throw new Error("Workflow path is not a file");
    }
    return resolved;
  } catch (error) {
    if (/\s/.test(trimmed) && extractErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function loadEmbeddedToolRuntimeFromPackage(): Promise<EmbeddedToolRuntime> {
  const coreSpecifier = ["@clawdbot", "lobster", "core"].join("/");
  return (await import(coreSpecifier)) as EmbeddedToolRuntime;
}

export function createEmbeddedLobsterRunner(options?: {
  loadRuntime?: () => Promise<EmbeddedToolRuntime>;
  storeOptions?: LobsterStoreOptions;
  callerId?: string;
  assertCurrent?: () => void;
}) {
  const loadRuntime = options?.loadRuntime ?? loadEmbeddedToolRuntimeFromPackage;
  let runtimePromise: Promise<EmbeddedToolRuntime> | undefined;
  return {
    async run(params: LobsterRunnerParams, signal?: AbortSignal): Promise<LobsterEnvelope> {
      if ((!["run", "resume"].includes(params.action) || params.waitId) && !options?.callerId) {
        throw new Error(
          "Lobster discovery and wait-ID resume require a trusted agent and session key",
        );
      }
      const controller = new AbortController();
      const requestSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      const timer = setTimeout(
        () => controller.abort(new Error("lobster runtime timed out")),
        Math.max(200, params.timeoutMs),
      );
      let store: StoreSession | undefined;
      try {
        runtimePromise ??= loadRuntime();
        const runtime = await runtimePromise;
        requestSignal.throwIfAborted();
        options?.assertCurrent?.();
        store = await runtime.openStoreSession({
          ...options?.storeOptions,
          history: Boolean(options?.callerId) && (options?.storeOptions?.history ?? false),
          trackRuns: Boolean(options?.callerId),
          env: { ...process.env },
          signal: requestSignal,
        });
        const maxBytes = Math.min(2_000_000, Math.max(1024, params.maxStdoutBytes));
        const ctx: EmbeddedToolContext = {
          storeSession: store,
          ...(options?.callerId ? { runMetadata: { callerId: options.callerId } } : {}),
          cwd: params.cwd,
          env: { ...process.env },
          mode: "tool",
          stdin: Readable.from([]),
          stdout: createLimitedSink(maxBytes, "stdout"),
          stderr: createLimitedSink(maxBytes, "stderr"),
          signal: requestSignal,
          assertInvocationCurrent: options?.assertCurrent,
        };
        const assertCurrent = () => {
          requestSignal.throwIfAborted();
          options?.assertCurrent?.();
        };
        assertCurrent();
        let envelope: LobsterEnvelope;
        if (params.action === "list") {
          const page = await runtime.listRuns({
            status: params.status,
            after: params.after,
            limit: params.limit,
            ctx,
          });
          envelope = { ok: true, output: [page] };
        } else if (params.action === "status") {
          if (!params.runId) {
            throw new Error("runId required");
          }
          const run = await runtime.getRun({ runId: params.runId, ctx });
          envelope = { ok: true, ...(run ? { runId: params.runId } : {}), output: [run] };
        } else if (params.action === "review") {
          if (!params.waitId) {
            throw new Error("waitId required");
          }
          const wait = await runtime.getWait({ waitId: params.waitId, ctx });
          envelope = { ok: true, ...(wait ? { runId: wait.runId } : {}), output: [wait] };
        } else if (params.action === "run") {
          const pipeline = params.pipeline?.trim() ?? "";
          if (!pipeline) {
            throw new Error("pipeline required");
          }
          const filePath = await detectWorkflowFile(pipeline, params.cwd);
          let args: Record<string, unknown> | undefined;
          if (filePath && params.argsJson?.trim()) {
            const parsed: unknown = JSON.parse(params.argsJson);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error("argsJson must be a JSON object");
            }
            args = parsed as Record<string, unknown>;
          }
          assertCurrent();
          envelope = filePath
            ? await runtime.runToolRequest({ filePath, args, ctx })
            : await runtime.runToolRequest({ pipeline, ctx });
        } else {
          const token = params.token?.trim() || undefined;
          const approvalId = params.approvalId?.trim() || undefined;
          const waitId = params.waitId?.trim() || undefined;
          if (!token && !approvalId && !waitId) {
            throw new Error("token, approvalId, or waitId required");
          }
          if (waitId && (token || approvalId)) {
            throw new Error("waitId cannot be combined with token or approvalId");
          }
          if (!waitId && params.expectedRevision !== undefined) {
            throw new Error("expectedRevision requires waitId");
          }
          if (
            waitId &&
            (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision! < 0)
          ) {
            throw new Error("waitId resume requires a nonnegative expectedRevision from review");
          }
          const hasApproval = typeof params.approve === "boolean";
          const hasResponse = params.responseJson !== undefined;
          const hasCancel = params.cancel !== undefined;
          if (Number(hasApproval) + Number(hasResponse) + Number(hasCancel) !== 1) {
            throw new Error(
              "resume requires exactly one of approve, responseJson, or cancel: true",
            );
          }
          if (hasCancel && params.cancel !== true) {
            throw new Error("cancel must be true");
          }
          const response: unknown = hasResponse ? JSON.parse(params.responseJson!) : undefined;
          assertCurrent();
          envelope = await runtime.resumeToolRequest({
            ...(token ? { token } : {}),
            ...(approvalId ? { approvalId } : {}),
            ...(waitId ? { waitId, expectedRevision: params.expectedRevision } : {}),
            ...(hasApproval ? { approved: params.approve } : {}),
            ...(hasResponse ? { response } : {}),
            ...(hasCancel ? { cancel: true } : {}),
            ctx,
          });
        }
        options?.assertCurrent?.();
        return normalizeEnvelope(envelope, maxBytes);
      } finally {
        clearTimeout(timer);
        // Abort requests do not settle a write. Join the executor before closing its store.
        await store?.close();
      }
    },
  };
}

export type LobsterRunner = ReturnType<typeof createEmbeddedLobsterRunner>;
