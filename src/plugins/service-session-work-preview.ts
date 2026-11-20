import { randomUUID } from "node:crypto";
import { emitAgentEventForOwner } from "../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import type { PluginServiceRecoveredSessionWorkContextV1 } from "./service-session-work.types.js";

/** Project live text through the usual chat router without claiming the durable session row. */
export function openSessionWorkAssistantPreview(
  target: PluginServiceRecoveredSessionWorkContextV1["target"],
  assertCurrent: () => void,
): ReturnType<PluginServiceRecoveredSessionWorkContextV1["openAssistantPreview"]> {
  assertCurrent();
  const runId = randomUUID();
  let claimId: string | undefined;
  let closed = false;
  return {
    publish(chunk) {
      if (closed) {
        return;
      }
      assertCurrent();
      claimId ??= claimAgentRunContext(
        runId,
        {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          sessionId: target.sessionId,
          projectSessionLifecycle: false,
          projectSessionActive: false,
        },
        { trackOwner: true, ownsContext: true, exclusive: true },
      );
      if (claimId) {
        emitAgentEventForOwner(
          { runId, stream: "assistant", data: { ...chunk, replaceable: true } },
          claimId,
        );
      }
    },
    [Symbol.dispose]() {
      closed = true;
      if (claimId) {
        // The durable notice is the only visible final answer. An empty
        // terminal retires the preview and cannot publish stale model text.
        emitAgentEventForOwner(
          {
            runId,
            stream: "lifecycle",
            data: {
              phase: "end",
              endedAt: Date.now(),
              terminalReply: { disposition: "silent" },
            },
          },
          claimId,
        );
        releaseAgentRunContext(runId, claimId);
        claimId = undefined;
      }
    },
  };
}
