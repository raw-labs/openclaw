import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import type { setActiveEmbeddedRun } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
} from "openclaw/plugin-sdk/llm";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import type { SessionGeneration, WaitState } from "./notices.js";

type Attempt = Parameters<AgentHarnessV2["runAttempt"]>[0];
type Route = { provider: string; modelId: string; profileId?: string };
type PiModel = Pick<
  Model,
  "id" | "name" | "api" | "input" | "reasoning" | "contextWindow" | "maxTokens"
> & {
  provider: string;
  cost: Pick<Model["cost"], "input" | "output" | "cacheRead" | "cacheWrite">;
};
export function piWorkerModel(model: Model): PiModel {
  const { id, name, api, provider, input, reasoning, cost, contextWindow, maxTokens } = model;
  // OpenClaw prices the provider response. Its unbounded pricing tiers are not Pi journal data.
  const { input: inputCost, output, cacheRead, cacheWrite } = cost;
  return {
    id,
    name,
    api,
    provider,
    input,
    reasoning,
    cost: { input: inputCost, output, cacheRead, cacheWrite },
    contextWindow,
    maxTokens,
  };
}
export type PiTurnRecovery = { id: string; parent?: SessionGeneration };
type ToolDescriptor = { name: string; description: string; parameters: object };
export type PiForkCheckpoint = { at: number; headKind?: string; messages: Message[] };
export type PiStartCommand = {
  action: "start";
  recovery?: PiTurnRecovery;
  seed?: Message[];
  checkpoint?: PiForkCheckpoint;
  model: PiModel;
  route: Route;
  prompt: string;
  instructions: string;
  runId: string;
  thinkingLevel: string;
  tools: ToolDescriptor[];
  images?: Attempt["images"];
};
type WorkerCommand =
  | PiStartCommand
  | { action: "compact"; model: PiModel; instructions?: string }
  | { action: "read-context"; maxChars: number }
  | { action: "read-checkpoint"; runId: string }
  | { action: "status" | "resume" | "cancel" }
  | { action: "signal"; approved: boolean };
export type WorkerResult = {
  recovery?: PiTurnRecovery;
  wait: WaitState;
  approvalId?: string;
  hasApproval?: boolean;
  compacted?: boolean;
  visibleContext?: string;
  checkpoint?: PiForkCheckpoint;
  signal?: "delivered" | "duplicate" | "closed";
  route?: Route & { api: Model["api"] };
  parent?: SessionGeneration;
  assistant?: AssistantMessage;
  runId?: string;
};
type HostRequest =
  | {
      kind: "model";
      purpose: "generation" | "compaction";
      context: Context;
      sessionId: string;
      reasoning?: Attempt["thinkLevel"];
      maxTokens?: number;
    }
  | { kind: "admit"; callId: string }
  | { kind: "check-session" }
  | { kind: "finalize"; answer: AssistantMessage }
  | { kind: "before-compaction"; messages: Message[] }
  | { kind: "after-compaction"; messages: Message[]; count: number }
  | { kind: "tool"; name: string; callId: string; args: Record<string, unknown> };
type ModelProgress = (event: AssistantMessageEvent) => void;
type HostCall = (request: HostRequest, progress: ModelProgress) => Promise<unknown>;

type InputStatus = "queued" | "placed" | "withdrawn" | "closed" | "unconfirmed";
type InputOptions = Parameters<Parameters<typeof setActiveEmbeddedRun>[1]["queueMessage"]>[1];
export type PiWorkerInput = {
  isAvailable(): boolean;
  submit(text: string, options: InputOptions): Promise<Exclude<InputStatus, "queued">>;
};

export function runWorker(
  database: string,
  command: WorkerCommand,
  signal: AbortSignal,
  hostCall?: HostCall,
  attachInput?: (input: PiWorkerInput) => (() => void) | undefined,
): Promise<WorkerResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      resolveRuntimeWorkerUrl({
        currentModuleUrl: import.meta.url,
        sourceWorkerName: "worker",
        sourceExtension: ".mjs",
        distWorkerPath: "extensions/pi-durable/worker.js",
        package: { name: "@openclaw/pi-durable", distWorkerPath: "worker.js" },
      }),
      {
        execArgv: [],
        env: {},
        workerData: { database, command },
      },
    );
    const stop = () => {
      void worker.terminate();
    };
    let result: WorkerResult | undefined;
    let failure: unknown;
    let inputAvailable = false;
    const pending = new Map<string, (status: InputStatus) => void>();
    const input: PiWorkerInput = {
      isAvailable: () => inputAvailable && !signal.aborted,
      submit(text, options) {
        const inputId = options?.queueIdentity ?? randomUUID();
        return new Promise((resolveInput) => {
          const withdraw = () => worker.postMessage({ kind: "withdraw-input", inputId }, []);
          const inputSignal = options?.abortSignal;
          inputSignal?.addEventListener("abort", withdraw, { once: true });
          const timer =
            options?.deliveryTimeoutMs === undefined
              ? undefined
              : setTimeout(withdraw, options.deliveryTimeoutMs);
          let accepted = false;
          pending.set(inputId, (status) => {
            if (!accepted) {
              options?.onQueueAccepted?.(status !== "closed" && status !== "withdrawn");
              accepted = true;
            }
            if (status !== "queued") {
              pending.delete(inputId);
              inputSignal?.removeEventListener("abort", withdraw);
              clearTimeout(timer);
              resolveInput(status);
            }
          });
          worker.postMessage({ kind: "steer-input", inputId, text, images: options?.images }, []);
        });
      },
    };
    let detachInput: (() => void) | undefined;
    try {
      detachInput = attachInput?.(input);
    } catch (error) {
      worker.once("error", () => {});
      stop();
      reject(
        error instanceof Error
          ? error
          : new Error("Pi Durable steering setup failed.", { cause: error }),
      );
      return;
    }
    if (signal.aborted) {
      stop();
    } else {
      signal.addEventListener("abort", stop, { once: true });
    }
    worker.on(
      "message",
      (
        message:
          | { kind: "result"; result: WorkerResult }
          | { kind: "input-ready" }
          | { kind: "input-status"; inputId: string; status: InputStatus }
          | { kind: "request"; requestId: number; request: HostRequest },
      ) => {
        if (message.kind === "input-ready") {
          inputAvailable = !signal.aborted;
          return;
        }
        if (message.kind === "input-status") {
          pending.get(message.inputId)?.(message.status);
          return;
        }
        if (message.kind === "result") {
          inputAvailable = false;
          result = message.result;
          return;
        }
        const { requestId, request } = message;
        void (async () => {
          try {
            signal.throwIfAborted();
            if (!hostCall) {
              throw new Error("This Pi worker cannot execute host operations.");
            }
            const value = await hostCall(request, (event) => {
              if (event.type !== "done" && event.type !== "error" && !signal.aborted) {
                worker.postMessage({ kind: "model-event", requestId, event }, []);
              }
            });
            worker.postMessage({ kind: "reply", requestId, ok: true, value }, []);
          } catch (error) {
            if (request.kind !== "model" || request.purpose !== "compaction") {
              failure = error;
            }
            worker.postMessage({ kind: "reply", requestId, ok: false }, []);
          }
        })();
      },
    );
    worker.once("error", (error) => {
      failure = error;
    });
    worker.once("exit", (code) => {
      signal.removeEventListener("abort", stop);
      inputAvailable = false;
      for (const settle of pending.values()) {
        settle("unconfirmed");
      }
      detachInput?.();
      if (signal.aborted) {
        reject(new Error("Pi Durable worker interrupted.", { cause: signal.reason }));
      } else if (code !== 0 || !result || failure) {
        reject(
          failure instanceof Error
            ? failure
            : new Error(`Pi Durable worker exited without a receipt (code ${code}).`, {
                cause: failure,
              }),
        );
      } else {
        resolve(result);
      }
    });
  });
}
