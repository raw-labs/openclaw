import {
  normalizeUsage,
  runAgentEndSideEffectsAsync,
  runAgentHarnessAfterCompactionHook,
  runAgentHarnessBeforeAgentFinalizeHook,
  runAgentHarnessBeforeCompactionHook,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage, Context, Message } from "openclaw/plugin-sdk/llm";
import { PLUGIN_ID } from "./identity.js";

type HookCtx = Parameters<typeof runAgentHarnessLlmInputHook>[0]["ctx"];

function textFromAnswer(answer: AssistantMessage) {
  return answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export function createPiTurnLifecycle(params: {
  ctx: HookCtx;
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  sessionFile: string;
  prompt?: string;
  allowFinalPresentation?: boolean;
  assertCurrent: () => void;
}) {
  const { ctx, runId, sessionId, provider, model, assertCurrent } = params;
  const identity = { runId, sessionId, provider, model };
  const started = Date.now();
  let modelIterations = 0;
  let history: Message[] = [];
  let finalPresentation: NonNullable<
    Awaited<ReturnType<typeof runAgentHarnessBeforeAgentFinalizeHook>> & { action: "continue" }
  >["finalPresentation"];
  return {
    get finalPresentation() {
      return finalPresentation;
    },
    modelInput(input: Context, purpose: "generation" | "compaction") {
      modelIterations++;
      if (purpose === "generation") {
        history = input.messages;
      }
      const user = input.messages.findLast(({ role }) => role === "user");
      const prompt = user
        ? typeof user.content === "string"
          ? user.content
          : user.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
        : "";
      runAgentHarnessLlmInputHook({
        ctx,
        event: {
          ...identity,
          systemPrompt: input.systemPrompt,
          prompt,
          imagesCount:
            user && Array.isArray(user.content)
              ? user.content.filter(({ type }) => type === "image").length
              : 0,
          historyMessages: input.messages,
          tools: input.tools,
        },
      });
    },
    modelOutput(answer: AssistantMessage) {
      runAgentHarnessLlmOutputHook({
        ctx,
        event: {
          ...identity,
          harnessId: PLUGIN_ID,
          prompt: params.prompt,
          assistantTexts: [textFromAnswer(answer)],
          lastAssistant: answer,
          usage: normalizeUsage(answer.usage),
        },
      });
    },
    async finalize(answer: AssistantMessage) {
      const decision = await runAgentHarnessBeforeAgentFinalizeHook({
        ctx,
        event: {
          ...identity,
          sessionKey: ctx.sessionKey,
          cwd: ctx.workspaceDir,
          transcriptPath: params.sessionFile,
          stopHookActive: modelIterations > 1,
          ...(params.allowFinalPresentation ? { supportsFinalPresentation: true } : {}),
          lastAssistantMessage: textFromAnswer(answer),
          messages: [...history, answer],
        },
      });
      assertCurrent();
      if (decision.action === "revise") {
        finalPresentation = undefined;
        return decision.reason;
      }
      finalPresentation = decision.finalPresentation;
      return undefined;
    },
    async beforeCompaction(messages: Message[]) {
      await runAgentHarnessBeforeCompactionHook({ ctx, sessionFile: params.sessionFile, messages });
      assertCurrent();
    },
    async afterCompaction(messages: Message[], compactedCount: number) {
      await runAgentHarnessAfterCompactionHook({
        ctx,
        sessionFile: params.sessionFile,
        messages,
        compactedCount,
      });
      assertCurrent();
    },
    async end(
      success: boolean,
      answer: AssistantMessage | undefined,
      facts?: Pick<Parameters<typeof runAgentEndSideEffectsAsync>[0], "completedTurnSource"> & {
        foregroundPromptContext?: Parameters<
          typeof runAgentEndSideEffectsAsync
        >[0]["ctx"]["foregroundPromptContext"];
      },
    ) {
      await runAgentEndSideEffectsAsync({
        ctx: { ...ctx, foregroundPromptContext: facts?.foregroundPromptContext },
        completedTurnSource: facts?.completedTurnSource,
        event: {
          runId,
          success,
          modelIterations,
          durationMs: Date.now() - started,
          messages: answer ? [...history, answer] : history,
        },
      });
    },
  };
}
