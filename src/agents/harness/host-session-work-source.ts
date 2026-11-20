import type { SandboxContext } from "../sandbox/types.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

export type HarnessSessionWorkWorkspace = {
  sessionKey: string;
  agentId?: string;
  sandboxIdentity: string;
  placementRuntimeId?: string;
};

export function captureHarnessSandboxIdentity(sandbox: SandboxContext): string {
  return JSON.stringify([
    sandbox.backendId,
    sandbox.runtimeId,
    sandbox.backend?.physicalRuntimeId,
    sandbox.backend?.configLabel,
    sandbox.agentWorkspaceDir,
    sandbox.workspaceDir,
    sandbox.containerWorkdir,
    sandbox.workspaceAccess,
  ]);
}

type HarnessSessionWorkSource = {
  pluginId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  workspace?: HarnessSessionWorkWorkspace;
  run: <T>(toolNames: readonly string[], work: () => Promise<T>) => Promise<T>;
};
const sessionWorkSources = new WeakMap<AgentHarnessHostCapabilities, HarnessSessionWorkSource>();

/** Only the admitted host's actual tool surface can authorize restart recovery. */
export function prepareHarnessSessionWorkSource(
  host: {
    pluginId: string;
    attempt: {
      agentId?: string;
      sessionKey?: string;
      sessionId?: string;
      sandbox?: SandboxContext | null;
    };
    toolCalls?: "deny";
  },
  caller: { assertToolAllowed?: (name: string) => void } | undefined,
  withCaller: <T>(work: () => Promise<T>) => Promise<T>,
) {
  const { agentId, sessionKey, sessionId, sandbox } = host.attempt;
  const workspace = sandbox?.enabled
    ? {
        sessionKey: sandbox.sessionKey,
        ...(sandbox.agentId ? { agentId: sandbox.agentId } : {}),
        sandboxIdentity: captureHarnessSandboxIdentity(sandbox),
        ...(sandbox.placementExecutionMode ? { placementRuntimeId: sandbox.runtimeId } : {}),
      }
    : undefined;
  const toolNames = new Set<string>();
  return {
    remember(tools: AnyAgentTool[]) {
      for (const { name } of tools) {
        toolNames.add(name);
      }
      return tools;
    },
    bind(capabilities: AgentHarnessHostCapabilities) {
      if (!caller || !agentId || !sessionKey || !sessionId || host.toolCalls === "deny") {
        return;
      }
      sessionWorkSources.set(capabilities, {
        pluginId: host.pluginId,
        agentId,
        sessionKey,
        sessionId,
        workspace,
        run(requested, work) {
          capabilities.assertActive();
          for (const name of requested) {
            caller.assertToolAllowed?.(name);
            if (!toolNames.has(name)) {
              throw new Error("Recovery cannot include tools outside the live harness surface.");
            }
          }
          return withCaller(work);
        },
      });
    },
  };
}

export const readHarnessSessionWorkSource = (capabilities: AgentHarnessHostCapabilities) =>
  sessionWorkSources.get(capabilities);
