import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import {
  prepareAgentWorkspaceContext,
  resolveAgentHarnessBeforePromptBuildResult,
  runAgentHarnessLlmInputHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import { readSessionTranscriptVisibleMessageDelta } from "openclaw/plugin-sdk/session-transcript-runtime";
import type { SessionGeneration } from "./notices.js";

type Attempt = Parameters<AgentHarnessV2["runAttempt"]>[0];

export function piHookContext(attempt: Attempt, toolNames?: readonly string[]) {
  return {
    config: attempt.config,
    runId: attempt.runId,
    agentId: attempt.agentId,
    sessionId: attempt.sessionId,
    sessionKey: attempt.sessionKey,
    workspaceDir: attempt.workspaceDir,
    modelProviderId: attempt.provider,
    modelId: attempt.modelId,
    memoryAudience: attempt.memoryAudience,
    messageProvider: attempt.messageProvider,
    accountId: attempt.agentAccountId,
    trigger: attempt.trigger,
    senderId: attempt.senderId ?? undefined,
    inputProvenance: attempt.inputProvenance,
    toolNames,
  } satisfies Parameters<typeof runAgentHarnessLlmInputHook>[0]["ctx"];
}

export async function preparePiPrompt(
  attempt: Attempt,
  generation: SessionGeneration,
  activeToolNames: () => readonly string[],
  restrictTools: (names: string[]) => void,
) {
  const { agentId, sessionKey, sessionId, workspaceDir, config, hostCapabilities: host } = attempt;
  const injection =
    (config && agentId ? resolveAgentConfig(config, agentId)?.contextInjection : undefined) ??
    config?.agents?.defaults?.contextInjection;
  const ambient = !attempt.modelRun && attempt.bootstrapContextMode !== "lightweight";
  const workspace =
    ambient && injection !== "never"
      ? await prepareAgentWorkspaceContext({
          scope: "full",
          config,
          workspaceDir,
          executionWorkspaceDir: attempt.sessionRoot,
          agentId,
          sessionId,
          sessionKey,
          chatType: attempt.chatType,
          bootstrapUserProfileId: attempt.sessionUserProfileId,
          contextMode: attempt.bootstrapContextMode,
          runKind: attempt.bootstrapContextRunKind,
          memoryTools: {
            toolNames: activeToolNames(),
            citationsMode: config?.memory?.citations,
            sandboxed: attempt.sandbox?.enabled === true,
          },
        })
      : undefined;
  host.assertActive();
  const instructions = [
    workspace?.instructionSnapshot.instructions,
    workspace?.personaInstructions,
    ...(workspace?.promptContextFiles.map(({ path, content }) => `## ${path}\n\n${content}`) ?? []),
    workspace?.memoryRecallInstructions,
    ambient ? attempt.skillsSnapshot?.prompt : undefined,
    attempt.extraSystemPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  const recorder = attempt.userTurnTranscriptRecorder;
  return await resolveAgentHarnessBeforePromptBuildResult({
    prompt: attempt.prompt,
    currentInboundContext: attempt.currentInboundContext,
    currentUserMessage: recorder?.message ?? (await recorder?.resolveMessage()) ?? attempt.prompt,
    developerInstructions: {
      build({ toolsAllow, hasToolRestrictions }) {
        if (hasToolRestrictions && toolsAllow) {
          restrictTools(toolsAllow);
        }
        return instructions;
      },
    },
    messages: async () => {
      host.assertActive();
      const page = await readSessionTranscriptVisibleMessageDelta({
        ...generation,
        start: "reset-window",
        maxBytes: 256 * 1024,
        maxMessages: 160,
      });
      host.assertActive();
      return page.kind === "page" ? page.entries.map(({ message }) => message) : [];
    },
    ctx: piHookContext(attempt, activeToolNames()),
    bootstrapContextRunKind: attempt.bootstrapContextRunKind,
    toolAuthority: {
      fingerprint: attempt.toolAuthorityFingerprint,
      activeToolNames,
      assertActive: host.assertActive,
    },
  });
}
