import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildRemoteCommand,
  buildRemoteWorkdirValidationCommand,
  buildValidatedExecRemoteCommand,
  createRemoteShellSandboxFsBridge,
  sanitizeEnvVars,
  type SandboxBackendHandle,
  type SandboxContext,
} from "openclaw/plugin-sdk/sandbox";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  PI_NODE_COMMAND,
  PI_NODE_COMMAND_BYTES,
  PI_NODE_MESSAGE_BYTES,
  PI_NODE_TIMEOUT_MS,
} from "./node-command.js";

// The ordinary exec supervisor owns this local relay as it would an ssh subprocess.
// It keeps no tool or model state, and disconnecting it cancels the node command.
const EXEC_RELAY = `
const { connect } = require("node:net");
const [port, admission, script] = process.argv.slice(1);
const socket = connect(Number(port), "127.0.0.1");
let response = "";
socket.on("connect", () => socket.write(JSON.stringify({ admission, script }) + "\\n"));
socket.setEncoding("utf8");
socket.on("data", (chunk) => { response += chunk; });
socket.on("error", (error) => { process.stderr.write(error.message); process.exitCode = 1; });
socket.on("end", () => {
  try {
    const result = JSON.parse(response);
    if (result.error) throw new Error(result.error);
    process.stdout.write(Buffer.from(result.stdout, "base64"));
    process.stderr.write(Buffer.from(result.stderr, "base64"));
    process.exitCode = result.code;
  } catch (error) {
    process.stderr.write(String(error.message) + "\\n");
    process.exitCode = 1;
  }
});
`;

type PlacedSandbox = Disposable & { sandbox: SandboxContext };

export function preparePiNodeWorkspace(
  api: OpenClawPluginApi,
  sandbox: SandboxContext | null | undefined,
  signal: AbortSignal,
  assertCurrent: () => void,
): PlacedSandbox | undefined {
  if (!sandbox || sandbox.backendId !== "node") {
    return undefined;
  }
  const {
    placementNodeId: nodeId,
    placementEnvironmentId,
    placementOwnerEpoch,
    placementSessionId,
  } = sandbox;
  if (!nodeId || !placementEnvironmentId || !placementOwnerEpoch || !placementSessionId) {
    throw new Error("Pi Durable requires a current node placement.");
  }
  const workspace = {
    workspaceDir: sandbox.containerWorkdir,
    environmentId: placementEnvironmentId,
    sessionId: placementSessionId,
    ownerEpoch: placementOwnerEpoch,
    sessionKey: sandbox.sessionKey,
  };
  const lifetime = new AbortController();
  const sockets = new Set<Socket>();
  const admissions = new Map<string, ReturnType<typeof AsyncLocalStorage.snapshot>>();
  let server: Server | undefined;
  let listener: Promise<number> | undefined;

  async function invoke(script: string, input?: string | Buffer, requestSignal?: AbortSignal) {
    assertCurrent();
    const abortSignal = AbortSignal.any(
      requestSignal ? [requestSignal, lifetime.signal, signal] : [lifetime.signal, signal],
    );
    abortSignal.throwIfAborted();
    const channel = await api.runtime.nodes.openDuplex({
      nodeId: nodeId!,
      command: PI_NODE_COMMAND,
      sessionKey: workspace.sessionKey,
      params: workspace,
      signal: abortSignal,
      assertCurrent,
      timeoutMs: PI_NODE_TIMEOUT_MS,
      maxMessageBytes: PI_NODE_MESSAGE_BYTES,
    });
    try {
      let receipt: unknown;
      const detach = channel.onMessage((bytes) => {
        receipt = JSON.parse(Buffer.from(bytes).toString("utf8"));
      });
      try {
        const request = Buffer.from(
          JSON.stringify({ script, stdin: input && Buffer.from(input).toString("base64") }),
        );
        if (request.byteLength > PI_NODE_MESSAGE_BYTES) {
          throw new Error("Pi Durable node command exceeds the transport limit.");
        }
        await channel.send(request);
        await channel.closed;
      } finally {
        detach();
      }
      assertCurrent();
      if (
        !isRecord(receipt) ||
        typeof receipt.stdout !== "string" ||
        typeof receipt.stderr !== "string" ||
        typeof receipt.code !== "number" ||
        !Number.isInteger(receipt.code)
      ) {
        throw new Error("Pi Durable received no worker command result.");
      }
      return {
        stdout: Buffer.from(receipt.stdout, "base64"),
        stderr: Buffer.from(receipt.stderr, "base64"),
        code: receipt.code,
      };
    } finally {
      channel.close();
    }
  }

  const connectRelay = async (): Promise<number> => {
    assertCurrent();
    if (!listener) {
      listener = new Promise((resolve, reject) => {
        const relay = createServer((socket) => {
          sockets.add(socket);
          const connection = new AbortController();
          socket.setEncoding("utf8");
          socket.on("error", () => socket.destroy());
          socket.once("close", () => {
            sockets.delete(socket);
            connection.abort();
          });
          let input = "";
          function receive(chunk: string) {
            input += chunk;
            if (input.length > PI_NODE_COMMAND_BYTES) {
              socket.destroy();
              return;
            }
            if (!input.endsWith("\n")) {
              return;
            }
            socket.off("data", receive);
            let request: unknown;
            try {
              request = JSON.parse(input);
            } catch {
              socket.destroy();
              return;
            }
            if (
              !isRecord(request) ||
              typeof request.admission !== "string" ||
              typeof request.script !== "string"
            ) {
              socket.destroy();
              return;
            }
            const scope = admissions.get(request.admission);
            if (!scope) {
              socket.destroy();
              return;
            }
            admissions.delete(request.admission);
            const { script } = request;
            void scope(async () => {
              try {
                const result = await invoke(script, undefined, connection.signal);
                socket.end(
                  JSON.stringify({
                    stdout: result.stdout.toString("base64"),
                    stderr: result.stderr.toString("base64"),
                    code: result.code,
                  }),
                );
              } catch (error) {
                socket.end(
                  JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
                );
              }
            });
          }
          socket.on("data", receive);
        });
        server = relay;
        relay.once("error", reject);
        relay.listen(0, "127.0.0.1", () => {
          const address = relay.address();
          if (!address || typeof address === "string") {
            reject(new Error("Pi Durable could not open its local node relay."));
            return;
          }
          resolve(address.port);
        });
      });
    }
    return await listener;
  };
  const backend: SandboxBackendHandle = {
    id: "node",
    runtimeId: sandbox.runtimeId,
    runtimeLabel: sandbox.runtimeLabel,
    workdir: workspace.workspaceDir,
    workdirValidation: "backend",
    async validateWorkdir(workdir) {
      const result = await invoke(
        buildRemoteWorkdirValidationCommand({ workdir, root: workspace.workspaceDir }),
      );
      return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
    },
    async buildExecSpec({ command, workdir, env, usePty }) {
      if (usePty) {
        throw new Error("Interactive PTY is unavailable for Pi Durable worker execution.");
      }
      const script = buildValidatedExecRemoteCommand({
        command,
        workdir: workdir ?? workspace.workspaceDir,
        env: {},
      });
      const locale = Object.entries(sanitizeEnvVars(env, { strictMode: true }).allowed)
        .filter(([key]) => key === "LANG" || key === "TZ" || key.startsWith("LC_"))
        .map(([key, value]) => `${key}=${value}`);
      const remote = buildRemoteCommand(["env", ...locale, "/bin/sh", "-c", script]);
      const port = await connectRelay();
      assertCurrent();
      const admission = randomBytes(24).toString("hex");
      admissions.set(admission, AsyncLocalStorage.snapshot());
      return {
        argv: [process.execPath, "--eval", EXEC_RELAY, String(port), admission, remote],
        env: sanitizeEnvVars(process.env).allowed,
        stdinMode: "pipe-closed",
        assertCurrent,
        finalizeToken: admission,
      };
    },
    async finalizeExec({ token }) {
      if (typeof token === "string") {
        admissions.delete(token);
      }
    },
    async runShellCommand({ script, args, stdin, allowFailure, signal: stop }) {
      const result = await invoke(
        buildRemoteCommand(["/bin/sh", "-c", script, "pi-durable", ...(args ?? [])]),
        stdin,
        stop,
      );
      if (result.code !== 0 && !allowFailure) {
        throw new Error(
          result.stderr.toString("utf8").trim() ||
            `Pi Durable worker command exited with code ${result.code}.`,
        );
      }
      return result;
    },
  };
  const context = { ...sandbox, required: true as const, backend };
  return {
    sandbox: {
      ...context,
      fsBridge: createRemoteShellSandboxFsBridge({
        sandbox: context,
        runtime: {
          remoteWorkspaceDir: workspace.workspaceDir,
          remoteAgentWorkspaceDir: workspace.workspaceDir,
          runRemoteShellScript: (request) => backend.runShellCommand(request),
        },
      }),
    },
    [Symbol.dispose]() {
      lifetime.abort();
      admissions.clear();
      for (const socket of sockets) {
        socket.destroy();
      }
      server?.close();
    },
  };
}
