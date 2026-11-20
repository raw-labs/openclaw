import { validateToolArguments } from "../../packages/llm-core/src/validation.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { HarnessSessionWorkWorkspace } from "../agents/harness/host-session-work-source.js";
import { captureHarnessSandboxIdentity } from "../agents/harness/host-session-work-source.js";
import { prepareAgentHarnessSessionRuntime } from "../agents/harness/session-preparation.js";
import { resolvePreparedSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { resolveSessionPermissionExecMode } from "../agents/session-permission-exec-mode.js";
import {
  prepareSessionPlacementSandbox,
  runRecoveredSessionPlacementTurn,
} from "../agents/session-placement-admission.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../agents/spawned-context.js";
import { resolveAttemptWorkspaceSandbox } from "../agents/workspace-sandbox.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginSessionWorkNodeTool } from "../gateway/plugin-session-work-authority.js";
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import type {
  PluginServiceRecoveredSessionWorkContextV1,
  PluginServiceSessionWorkContextV1,
  PluginServiceSessionWorkTools,
} from "./service-session-work.types.js";

/** Reacquire the original sandbox under the recovered caller before constructing any tools. */
export async function prepareSessionWorkWorkspaceTools(params: {
  workspace?: HarnessSessionWorkWorkspace;
  target: PluginServiceSessionWorkContextV1["target"];
  route: Parameters<
    PluginServiceRecoveredSessionWorkContextV1["withWorkspaceExecution"]
  >[0]["model"];
  prepareNodeWorkspace?: Parameters<
    PluginServiceRecoveredSessionWorkContextV1["withWorkspaceExecution"]
  >[0]["prepareNodeWorkspace"];
  runId?: string;
  resolveGatewayContext?: GatewayContextResolver;
  storePath?: string;
  pluginId: string;
  authority: AdmittedRunOperatorAuthority;
  tools: readonly string[];
  config: OpenClawConfig;
  entry: SessionEntry;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<PluginServiceSessionWorkTools | undefined> {
  const { target, route, entry, workspace, config } = params;
  const { agentId, sessionId, sessionKey } = target;
  const workspaceDir =
    resolveIngressWorkspaceOverrideForSessionRun({
      spawnedBy: entry.spawnedBy,
      workspaceDir: entry.spawnedWorkspaceDir,
      cwd: entry.spawnedCwd,
    }) ?? resolveAgentWorkspaceDir(config, agentId);
  using lifetime = new DisposableStack();
  const placement = lifetime.use(
    await prepareSessionPlacementSandbox({ ...target, config, workspaceDir }),
  );
  const assertCurrent = () => {
    params.assertCurrent();
    placement.assertCurrent();
  };
  assertCurrent();
  if (placement.workerAssigned && params.runId === undefined) {
    throw new Error("Recovered work requires a current worker placement turn claim.");
  }
  if (!workspace) {
    const sandboxed = resolvePreparedSandboxRuntimeStatus({
      cfg: config,
      sessionKey,
      agentId,
      preparedSessionEntry: entry,
    }).sandboxed;
    if (sandboxed) {
      throw new Error("The original turn was not admitted in the current sandbox workspace.");
    }
    return undefined;
  }
  const placed = lifetime.use(
    await resolveAttemptWorkspaceSandbox({
      agentId,
      sessionId,
      sessionKey,
      config,
      workspaceDir,
      sandboxSessionKey: workspace.sessionKey,
      sandboxAgentId: workspace.agentId,
      permissionMode: entry.permissionMode,
      sessionRoot: entry.sessionRoot,
      abortSignal: params.signal,
      placementSandbox: placement.sandbox,
    }),
  );
  assertCurrent();
  const sandbox = placement.sandbox ?? placed.sandbox;
  if (!sandbox?.enabled || captureHarnessSandboxIdentity(sandbox) !== workspace.sandboxIdentity) {
    throw new Error("The original sandbox workspace is unavailable for recovery.");
  }
  if (
    sandbox.backendId === "node" &&
    (entry.sandbox === "required" || params.authority.rolePolicy?.sandboxRequired)
  ) {
    throw new Error(
      "This session requires sandbox isolation. Paired-node workspaces use the node account's permissions.",
    );
  }
  const setup = await prepareAgentHarnessSessionRuntime({
    ownerPluginId: params.pluginId,
    nativeModelPolicySupport: "exact",
    sourceAuthority: params.authority,
    runId: params.runId,
    resolveGatewayContext: params.resolveGatewayContext,
    assertCurrent,
    input: {
      ...target,
      ...(params.storePath
        ? {
            sessionTarget: {
              ...target,
              storePath: params.storePath,
              expectedLifecycleRevision: target.lifecycleRevision,
            },
          }
        : {}),
      config,
      agentDir: resolveAgentDir(config, agentId),
      workspaceDir: placed.effectiveWorkspace,
      cwd: placed.effectiveCwd,
      provider: route.provider,
      modelId: route.model,
      sandbox,
      permissionMode: entry.permissionMode,
      sessionRoot: placed.sessionPermissionRoot,
      toolOverrides: entry.toolOverrides,
      spawnedBy: entry.spawnedBy,
      groupId: entry.groupId,
      groupChannel: entry.groupChannel,
      groupSpace: entry.space,
      abortSignal: params.signal,
    },
  });
  lifetime.defer(setup.dispose);
  const { preparation } = setup;
  const tools = await preparation.run(async () => {
    const nodeWorkspace =
      sandbox.backendId === "node"
        ? params.prepareNodeWorkspace?.(sandbox, params.signal, assertCurrent)
        : undefined;
    if (sandbox.backendId === "node" && !nodeWorkspace) {
      throw new Error("The harness did not prepare its admitted worker tool transport.");
    }
    lifetime.use(nodeWorkspace);
    const surface = await preparation.params.hostCapabilities.createToolSurfaceAsync?.({
      config,
      agentId,
      agentDir: preparation.params.agentDir,
      sessionId,
      sessionKey,
      runId: preparation.params.runId,
      workspaceDir: preparation.params.workspaceDir,
      cwd: preparation.params.cwd,
      modelProvider: route.provider,
      modelId: route.model,
      sandbox: nodeWorkspace?.sandbox ?? sandbox,
      abortSignal: params.signal,
      runtimeToolAllowlist: [...params.tools],
      sessionPermissionPolicy: placed.sessionPermissionPolicy,
      exec: {
        host: "sandbox",
        ...(entry.permissionMode
          ? { mode: resolveSessionPermissionExecMode({ mode: entry.permissionMode }) }
          : {}),
      },
    });
    if (!surface) {
      throw new Error("OpenClaw could not prepare the recovered sandbox tool surface.");
    }
    return new Map(surface.map((tool) => [tool.name, tool]));
  });
  assertCurrent();
  const retained = lifetime.move();
  return {
    [Symbol.dispose]: () => retained.dispose(),
    async invoke({ name, callId, args, signal }) {
      return await preparation.run(async () => {
        assertCurrent();
        signal.throwIfAborted();
        const tool = tools.get(name);
        if (!params.tools.includes(name) || !tool?.execute) {
          throw new Error("This tool is unavailable in the recovered sandbox workspace.");
        }
        validateToolArguments(tool, { type: "toolCall", name, id: callId, arguments: args });
        const execute = () => tool.execute(callId, args, signal);
        return await (sandbox.backendId === "node"
          ? withPluginSessionWorkNodeTool(name, execute)
          : execute());
      });
    },
  };
}

export async function runSessionWorkInWorkspace<T>(
  params: Parameters<typeof prepareSessionWorkWorkspaceTools>[0] & {
    runId: string;
    storePath: string;
  },
  execute: (tools: PluginServiceSessionWorkTools | undefined, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const runtimeId = params.workspace?.placementRuntimeId;
  if (!runtimeId) {
    using tools = await prepareSessionWorkWorkspaceTools({ ...params, runId: undefined });
    return await execute(tools, params.signal);
  }
  const { target, config, entry } = params;
  const workspaceDir =
    resolveIngressWorkspaceOverrideForSessionRun({
      spawnedBy: entry.spawnedBy,
      workspaceDir: entry.spawnedWorkspaceDir,
      cwd: entry.spawnedCwd,
    }) ?? resolveAgentWorkspaceDir(config, target.agentId);
  return await runRecoveredSessionPlacementTurn(
    {
      target: { ...target, storePath: params.storePath },
      config,
      workspaceDir,
      runId: params.runId,
      runtimeId,
      signal: params.signal,
      assertCurrent: params.assertCurrent,
    },
    async (signal) => {
      using tools = await prepareSessionWorkWorkspaceTools({ ...params, signal });
      return await execute(tools, signal);
    },
  );
}
