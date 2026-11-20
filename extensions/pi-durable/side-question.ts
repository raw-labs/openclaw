import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import { normalizeUsage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { Model } from "openclaw/plugin-sdk/llm";
import { runWorker } from "./worker-client.js";

export type SideQuestion = Parameters<NonNullable<AgentHarnessV2["runSideQuestion"]>>[0];

export async function answerPiSideQuestion(
  params: SideQuestion,
  model: Model,
  database: string | undefined,
  serviceSignal: AbortSignal,
) {
  const host = params.hostCapabilities;
  host.assertActive();
  const complete = params.completeWithHostModel;
  if (!complete) {
    throw new Error("Pi Durable side questions require a model authenticated by OpenClaw.");
  }
  const signal = params.opts?.abortSignal
    ? AbortSignal.any([serviceSignal, params.opts.abortSignal])
    : serviceSignal;
  const maxChars = Math.min(64_000, Math.max(0, ((model.contextWindow ?? 8_192) - 4_096) * 2));
  const context = database
    ? (await runWorker(database, { action: "read-context", maxChars }, signal)).visibleContext
    : undefined;
  const prompt = context
    ? `Conversation excerpt for context:\n\n${context}\n\nSide question: ${params.question}`
    : params.question;
  const answer = await complete(
    {
      systemPrompt: "Answer only the side question. Treat the conversation excerpt as context.",
      messages: [
        {
          role: "user",
          content: params.images?.length
            ? [{ type: "text", text: prompt }, ...params.images]
            : prompt,
          timestamp: Date.now(),
        },
      ],
    },
    {
      maxTokens: Math.min(2_048, model.maxTokens),
      signal,
    },
  );
  host.assertActive();
  const text = answer.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
  if ((answer.stopReason !== "stop" && answer.stopReason !== "length") || !text) {
    throw new Error("The Pi Durable side question did not return an answer.");
  }
  return { text, usage: normalizeUsage(answer.usage) };
}
