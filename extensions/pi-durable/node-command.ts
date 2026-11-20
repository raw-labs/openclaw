import path from "node:path";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { sanitizeEnvVars } from "openclaw/plugin-sdk/sandbox";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const PI_NODE_COMMAND = "pi-durable.workspace.exec.v1";
const CAPABILITY = "pi-durable.workspace";
// Base64 expands the byte payload before the node duplex transport frames it.
export const PI_NODE_COMMAND_BYTES = 32 * 1024 * 1024;
export const PI_NODE_MESSAGE_BYTES = 64 * 1024 * 1024;
export const PI_NODE_TIMEOUT_MS = 10 * 60_000;

function readPlacement(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.workspaceDir !== "string" ||
    !path.posix.isAbsolute(value.workspaceDir) ||
    path.posix.normalize(value.workspaceDir) !== value.workspaceDir ||
    value.workspaceDir === "/" ||
    value.workspaceDir.includes("\0") ||
    typeof value.sessionId !== "string" ||
    typeof value.sessionKey !== "string" ||
    typeof value.environmentId !== "string" ||
    typeof value.ownerEpoch !== "number" ||
    !Number.isSafeInteger(value.ownerEpoch) ||
    value.ownerEpoch < 1
  ) {
    throw new Error("Pi Durable node execution requires an exact managed workspace binding.");
  }
  return {
    workspaceDir: value.workspaceDir,
    sessionKey: value.sessionKey,
    sessionId: value.sessionId,
    environmentId: value.environmentId,
    ownerEpoch: value.ownerEpoch,
  };
}

export function createPiNodeCommand(): OpenClawPluginNodeHostCommand {
  let activeWorkspaces = 0;
  return {
    command: PI_NODE_COMMAND,
    cap: CAPABILITY,
    dangerous: true,
    duplex: true,
    hasActiveWork: () => activeWorkspaces > 0,
    isAvailable: () => process.platform === "linux" || process.platform === "darwin",
    async handle(paramsJSON, io, context) {
      const input: unknown = JSON.parse(paramsJSON ?? "null");
      if (
        !isRecord(input) ||
        (input.authorization !== "human-approved" && input.authorization !== "session-full") ||
        !io?.frames ||
        !context?.acquireManagedWorkspaceAsync ||
        !context.prepareExecAuthorization
      ) {
        throw new Error("Pi Durable requires approved managed node execution.");
      }
      const { frames } = io;
      const signal = context.signal ? AbortSignal.any([io.signal, context.signal]) : io.signal;
      const placement = readPlacement(input.placement);
      if (context.sessionKey !== placement.sessionKey) {
        throw new Error("Pi Durable node execution belongs to a different session.");
      }
      const assertExecAuthorized = context.prepareExecAuthorization(input.authorization);
      signal.throwIfAborted();
      const workspace = await context.acquireManagedWorkspaceAsync(placement);
      activeWorkspaces += 1;
      let stopListening: (() => void) | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          let accepted = false;
          const onAbort = () => {
            // Once a process starts, wait for its owned cleanup before releasing the workspace.
            if (!accepted) {
              reject(new Error("Pi Durable node command was cancelled.", { cause: signal.reason }));
            }
          };
          const detach = frames.onMessage(async (frame) => {
            if (accepted) {
              throw new Error("Pi Durable node invocation accepts one command.");
            }
            accepted = true;
            try {
              if (frame.byteLength > PI_NODE_MESSAGE_BYTES) {
                throw new Error("Pi Durable node command exceeds the transport limit.");
              }
              const command: unknown = JSON.parse(Buffer.from(frame).toString("utf8"));
              if (
                !isRecord(command) ||
                typeof command.script !== "string" ||
                !command.script ||
                command.script.includes("\0") ||
                (command.stdin !== undefined && typeof command.stdin !== "string")
              ) {
                throw new Error("Invalid Pi Durable node command.");
              }
              const stdin = Buffer.from(command.stdin ?? "", "base64");
              if (stdin.byteLength > PI_NODE_COMMAND_BYTES) {
                throw new Error("Pi Durable node command input exceeds the transport limit.");
              }
              signal.throwIfAborted();
              assertExecAuthorized();
              const result = await runCommandBuffered(["/bin/sh", "-c", command.script], {
                cwd: workspace.workspaceDir,
                baseEnv: sanitizeEnvVars(process.env).allowed,
                input: stdin,
                signal,
                timeoutMs: PI_NODE_TIMEOUT_MS,
                maxCombinedOutputBytes: PI_NODE_COMMAND_BYTES,
                killProcessTree: true,
                executionIntent: "agent-tool",
                executionScopeKey: placement.sessionKey,
              });
              signal.throwIfAborted();
              if (result.termination !== "exit" || result.code === null) {
                throw new Error(`Pi Durable node command stopped with ${result.termination}.`);
              }
              await frames.send(
                Buffer.from(
                  JSON.stringify({
                    stdout: result.stdout.toString("base64"),
                    stderr: result.stderr.toString("base64"),
                    code: result.code,
                  }),
                ),
              );
              resolve();
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          });
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) {
            onAbort();
          }
          stopListening = () => {
            detach();
            signal.removeEventListener("abort", onAbort);
          };
        });
        return "{}";
      } finally {
        stopListening?.();
        activeWorkspaces -= 1;
        workspace.release();
      }
    },
  };
}

export function createPiNodeInvokePolicy(): OpenClawPluginNodeInvokePolicy {
  return {
    commands: [PI_NODE_COMMAND],
    dangerous: true,
    classifyRisk: () => ({ level: "high", family: CAPABILITY }),
    standingApproval: { kind: "placement", scope: CAPABILITY },
    async handle(context) {
      if (context.risk?.level !== "high" || !context.invokeNodeWithSessionFull) {
        return {
          ok: false,
          code: "APPROVAL_REQUIRED",
          message:
            "Pi Durable node execution requires an admitted Pi Durable placement and approval.",
        };
      }
      const workspace = readPlacement(context.params);
      const full = await context.invokeNodeWithSessionFull({
        workspace,
        createParams: () => ({ placement: workspace, authorization: "session-full" }),
      });
      if (full) {
        return full;
      }
      const authorization = await context.approvals?.request({
        title: "Run Pi Durable tools on this worker",
        description: `Authorizes processes and file access using the worker's operating-system account. The approval applies to the selected placement at ${workspace.workspaceDir}.`,
        severity: "critical",
        allowedDecisions: ["allow-once", "allow-always"],
      });
      if (authorization?.decision !== "allow-once" && authorization?.decision !== "allow-always") {
        return {
          ok: false,
          code: "APPROVAL_REQUIRED",
          message: "Pi Durable worker execution was not approved.",
        };
      }
      return await context.invokeNode({
        workspace,
        params: { placement: workspace, authorization: "human-approved" },
      });
    },
  };
}
