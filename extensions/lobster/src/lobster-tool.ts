import { optionalPositiveIntegerSchema } from "openclaw/plugin-sdk/channel-actions";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import {
  createEmbeddedLobsterRunner,
  resolveLobsterCwd,
  type LobsterRunnerParams,
  type LobsterRunner,
} from "./lobster-runner.js";
export function createLobsterTool(options?: { runner?: LobsterRunner }) {
  const runner = options?.runner ?? createEmbeddedLobsterRunner();
  return {
    name: "lobster",
    label: "Lobster Workflow",
    description:
      "Run Lobster workflows and rediscover saved runs in this conversation. Use list (optionally status: waiting), status with runId for pending wait IDs, and review with waitId for the saved question and revision. Present the saved review to the user before resuming with waitId and expectedRevision. For needs_input use their answer as responseJson matching responseSchema; for approvals use approve. Existing token/approvalId resume remains supported. Use cancel: true to cancel. A running record after a crash does not authorize replay; never automatically retry uncertain side effects.",
    parameters: Type.Object({
      action: Type.Enum(["run", "resume", "list", "status", "review"], { type: "string" }),
      runId: Type.Optional(Type.String()),
      waitId: Type.Optional(Type.String()),
      expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
      status: Type.Optional(
        Type.Enum(["running", "waiting", "completed", "failed", "cancelled"], { type: "string" }),
      ),
      after: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      pipeline: Type.Optional(Type.String()),
      argsJson: Type.Optional(Type.String()),
      token: Type.Optional(Type.String()),
      approvalId: Type.Optional(Type.String()),
      approve: Type.Optional(Type.Boolean()),
      responseJson: Type.Optional(
        Type.String({
          description: "User's answer as JSON for an input checkpoint. Use instead of approve.",
        }),
      ),
      cancel: Type.Optional(Type.Literal(true)),
      cwd: Type.Optional(
        Type.String({
          description:
            "Relative working directory (optional). Must stay within the gateway working directory.",
        }),
      ),
      timeoutMs: optionalPositiveIntegerSchema(),
      maxStdoutBytes: optionalPositiveIntegerSchema({ maximum: 2_000_000 }),
    }),
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const action = typeof params.action === "string" ? params.action.trim() : "";
      if (!action) {
        throw new Error("action required");
      }
      if (
        action !== "run" &&
        action !== "resume" &&
        action !== "list" &&
        action !== "status" &&
        action !== "review"
      ) {
        throw new Error(`Unknown action: ${action}`);
      }

      const cwd = resolveLobsterCwd(params.cwd);
      const timeoutMs = readPositiveIntegerParam(params, "timeoutMs") ?? 20_000;
      const maxStdoutBytes = readPositiveIntegerParam(params, "maxStdoutBytes") ?? 512_000;

      const runnerParams: LobsterRunnerParams = {
        action,
        ...(typeof params.runId === "string" ? { runId: params.runId } : {}),
        ...(typeof params.waitId === "string" ? { waitId: params.waitId } : {}),
        ...(typeof params.expectedRevision === "number"
          ? { expectedRevision: params.expectedRevision }
          : {}),
        ...(typeof params.status === "string" ? { status: readRunStatus(params.status) } : {}),
        ...(typeof params.after === "string" ? { after: params.after } : {}),
        ...(params.limit !== undefined ? { limit: readPositiveIntegerParam(params, "limit") } : {}),
        ...(typeof params.pipeline === "string" ? { pipeline: params.pipeline } : {}),
        ...(typeof params.argsJson === "string" ? { argsJson: params.argsJson } : {}),
        ...(typeof params.token === "string" ? { token: params.token } : {}),
        ...(typeof params.approvalId === "string" ? { approvalId: params.approvalId } : {}),
        ...(typeof params.approve === "boolean" ? { approve: params.approve } : {}),
        ...(typeof params.responseJson === "string" ? { responseJson: params.responseJson } : {}),
        ...(typeof params.cancel === "boolean" ? { cancel: params.cancel } : {}),
        cwd,
        timeoutMs,
        maxStdoutBytes,
      };

      const envelope = await runner.run(runnerParams, signal);
      return { ...jsonResult(envelope), ...(!envelope.ok ? { isError: true } : {}) };
    },
  };
}

function readRunStatus(status: string): NonNullable<LobsterRunnerParams["status"]> {
  switch (status) {
    case "running":
    case "waiting":
    case "completed":
    case "failed":
    case "cancelled":
      return status;
    default:
      throw new Error("Invalid run status");
  }
}
