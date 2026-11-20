import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import { emitAgentHarnessAttemptEvent } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import { createStreamingDirectiveAccumulator } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessageEvent } from "openclaw/plugin-sdk/llm";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type Attempt = Parameters<AgentHarnessV2["runAttempt"]>[0];

export function createPiModelPreview(
  attempt: Pick<
    Attempt,
    | "runId"
    | "sessionKey"
    | "onAgentEvent"
    | "suppressLiveStreamOutput"
    | "reasoningLevel"
    | "onReasoningStream"
    | "onReasoningEnd"
    | "onAssistantMessageStart"
    | "onPartialReply"
  >,
  log: OpenClawPluginApi["logger"],
  publish?: (chunk: { text: string; delta: string; itemId: string }) => void,
) {
  let round = 0;
  let started = false;
  return () => {
    const itemId = `pi-durable:${attempt.runId}:${++round}`;
    const directives = createStreamingDirectiveAccumulator();
    let text = "";
    let reasoning = "";
    return async (event: AssistantMessageEvent) => {
      if (attempt.suppressLiveStreamOutput) {
        return;
      }
      if (event.type === "thinking_delta" && attempt.reasoningLevel === "stream") {
        reasoning += event.delta;
        await attempt.onReasoningStream?.({ text: reasoning });
      } else if (event.type === "thinking_end" && reasoning) {
        await attempt.onReasoningEnd?.();
      }
      if (event.type !== "text_delta" && event.type !== "done") {
        return;
      }
      const delta = directives.consume(event.type === "text_delta" ? event.delta : "", {
        final: event.type === "done",
      })?.text;
      if (!delta) {
        return;
      }
      if (!started) {
        started = true;
        await attempt.onAssistantMessageStart?.();
      }
      const replace = !text && round > 1;
      text += delta;
      if (publish) {
        publish({ text, delta, itemId });
        return;
      }
      // Tool rounds may produce prose before the final answer. Keep the preview replaceable.
      await emitAgentHarnessAttemptEvent(
        attempt,
        { stream: "assistant", data: { text, delta, itemId, replaceable: true } },
        { label: "Pi Durable", log: { debug: (message) => log.debug?.(message) } },
      );
      await attempt.onPartialReply?.({ text, delta, ...(replace ? { replace: true } : {}) });
    };
  };
}
