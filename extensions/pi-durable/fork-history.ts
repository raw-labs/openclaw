import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import { isTranscriptOnlyOpenClawAssistantMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { Message } from "openclaw/plugin-sdk/llm";
import { readSessionTranscriptVisibleMessageDelta } from "openclaw/plugin-sdk/session-transcript-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { PLUGIN_ID } from "./identity.js";
import type { SessionGeneration } from "./notices.js";

type Attempt = Parameters<AgentHarnessV2["runAttempt"]>[0];

/** Seed a new Pi journal from the session’s committed path before its current input. */
export async function preparePiInitialHistory(
  attempt: Attempt,
  generation: SessionGeneration,
): Promise<{ seed: Message[]; nativeRunId?: string }> {
  const host = attempt.hostCapabilities;
  host.assertActive();
  const page = await readSessionTranscriptVisibleMessageDelta({
    ...generation,
    start: "reset-window",
    maxMessages: 1024,
    maxBytes: 1024 * 1024,
  });
  host.assertActive();
  if (page.kind !== "page") {
    throw new Error("The committed session history is unavailable.");
  }
  const recorder = attempt.userTurnTranscriptRecorder;
  const pendingUserKey =
    recorder?.getAdmissionReceipt()?.idempotencyKey ??
    recorder?.message?.idempotencyKey ??
    `${attempt.runId}:user`;
  const seed: Message[] = [];
  let nativeRunId: string | undefined;
  for (const entry of page.entries) {
    const { message } = entry;
    if (entry.idempotencyKey === pendingUserKey) {
      break;
    }
    if (
      message.role === "user" &&
      !("excludeFromContext" in message && message.excludeFromContext === true)
    ) {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      if (content) {
        seed.push({ role: "user", content, timestamp: message.timestamp });
      }
    }
    if (message.role === "assistant" && "openclawDeliveryMirror" in message) {
      const notice = message.openclawDeliveryMirror;
      if (
        isRecord(notice) &&
        notice.kind === "plugin-notice" &&
        notice.pluginId === PLUGIN_ID &&
        notice.type === "completed" &&
        isRecord(notice.data) &&
        typeof notice.data.runId === "string"
      ) {
        // Only the notice posted into the child chat carries a Pi checkpoint reference.
        nativeRunId = notice.data.runId;
      }
    }
    if (
      message.role === "assistant" &&
      (message.stopReason === "stop" || message.stopReason === "length") &&
      !isTranscriptOnlyOpenClawAssistantMessage(message)
    ) {
      const content = message.content.filter((part) => part.type === "text");
      if (content.length) {
        const native = entry.idempotencyKey?.match(/^pi-durable:reply:(.+)$/u)?.[1];
        nativeRunId = native;
        const { api, model, provider, usage, stopReason, timestamp } = message;
        seed.push({
          role: "assistant",
          content,
          api,
          model,
          provider,
          usage,
          stopReason,
          timestamp,
        });
      }
    }
  }
  if (page.hasMore) {
    throw new Error("The session exceeds Pi Durable's initial history allowance.");
  }
  return { seed, nativeRunId };
}
