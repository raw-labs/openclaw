import type { ProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { AgentToolResult } from "../../packages/agent-core/src/types.js";
import type { AgentHarnessHostCapabilities } from "../agents/harness/host-capability-types.js";
import type { SandboxContext } from "../agents/sandbox/types.js";

/** One current execution borrow, issued by the host for live or previously accepted work. */
export type PluginServiceSessionWorkContextV1 = {
  readonly target: Readonly<{
    agentId: string;
    sessionKey: string;
    sessionId: string;
    lifecycleRevision?: string;
  }>;
  readonly signal: AbortSignal;
  assertCurrent: () => void;
};

export type PluginServiceSessionWorkTools = Disposable & {
  invoke: (input: {
    name: string;
    callId: string;
    args: Record<string, unknown>;
    signal: AbortSignal;
  }) => Promise<AgentToolResult<unknown>>;
};

export type PluginServiceRecoveredSessionWorkContextV1 = PluginServiceSessionWorkContextV1 & {
  /** Runs a continuation under the original workspace owner and settles its workspace changes. */
  withWorkspaceExecution: <T>(
    request: {
      model: ProviderModelRef;
      runId: string;
      signal: AbortSignal;
      prepareNodeWorkspace?: (
        sandbox: SandboxContext,
        signal: AbortSignal,
        assertCurrent: () => void,
      ) => (Disposable & { sandbox: SandboxContext }) | undefined;
    },
    execute: (
      workspace: PluginServiceSessionWorkTools | undefined,
      signal: AbortSignal,
    ) => Promise<T>,
  ) => Promise<T>;
  /** A transient, session-scoped chat preview. The service retains ownership of its durable reply. */
  openAssistantPreview: () => {
    publish: (chunk: { itemId: string; text: string; delta: string }) => void;
    [Symbol.dispose]: () => void;
  };
  /** Bind one model request to this recovered source and current operator model policy. */
  withModelExecution: <T>(
    model: ProviderModelRef,
    execute: (execution: { signal: AbortSignal; assertCurrent: () => void }) => Promise<T>,
  ) => Promise<T>;
};

/** Durable admission is host-owned. IDs and plugin state are not credentials. */
export type PluginServiceSessionWorkV1 = {
  readonly version: 1;
  /** Borrow the original live invocation's current target without accepting work or
   * writing an admission. Retained contexts fail after the callback settles.
   */
  withCurrent: <T>(
    input: { agentId: string; sessionKey: string; toolName: string },
    work: (context: PluginServiceSessionWorkContextV1) => Promise<T>,
  ) => Promise<T>;
  /** Called within the original live invocation, before accepting external work.
   * Requested tools are checked against that invocation and current session policy;
   * they restrict later effects, never expand the caller's executable surface.
   */
  admit: (input: {
    id: string;
    agentId: string;
    sessionKey: string;
    toolName: string;
    delegatedTools?: readonly string[];
  }) => Promise<{ recoverable: boolean; target: PluginServiceSessionWorkContextV1["target"] }>;
  /** Accept restart recovery for the service's exact admitted harness attempt.
   * A source without restart authority keeps its foreground admission and writes no work record.
   */
  admitTurn?: (input: {
    id: string;
    source: AgentHarnessHostCapabilities;
    toolNames: readonly string[];
  }) => Promise<{ recoverable: boolean; target: PluginServiceSessionWorkContextV1["target"] }>;
  /** Reauthorize the exact accepted source. Unavailable authority produces no effects. */
  run: <T>(
    id: string,
    work: (context: PluginServiceRecoveredSessionWorkContextV1) => Promise<T>,
  ) => Promise<
    | { status: "completed"; value: T }
    | { status: "unavailable"; reason: string; retryAfterMs?: number }
  >;
};
