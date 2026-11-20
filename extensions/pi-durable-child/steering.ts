import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import { setActiveEmbeddedRun } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  MessageInjectionTargetUnavailableError,
  MessageInjectionWithdrawnError,
  withMessageInjectionAdmission,
} from "openclaw/plugin-sdk/agent-harness-session-runtime";
import type { PiWorkerInput } from "./worker-client.js";

type Attempt = Parameters<AgentHarnessV2["runAttempt"]>[0];
type Handle = Parameters<typeof setActiveEmbeddedRun>[1];
type Injection = NonNullable<Handle["messageInjectionV2"]>;
type QueueOptions = Parameters<Injection["queueMessage"]>[1];

export function attachPiSteering(params: Attempt, input: PiWorkerInput, stop: AbortController) {
  const assertActive = params.hostCapabilities.assertActive;
  const isAvailable = () => input.isAvailable() && !stop.signal.aborted;
  const queueMessage = async (
    text: string,
    options: QueueOptions,
    assertCurrent: () => void,
    prepareCurrent?: () => Promise<void>,
  ) => {
    const unconfirmed = {
      transcriptCommit: "unconfirmed" as const,
      errorMessage: "Pi Durable could not confirm that the steered input reached the transcript.",
    };
    try {
      const prompt = [options?.currentInboundContext?.text, text].filter(Boolean).join("\n\n");
      const { outcome } = await withMessageInjectionAdmission(prepareCurrent, () => {
        options?.abortSignal?.throwIfAborted();
        assertActive();
        assertCurrent();
        if (!isAvailable()) {
          throw new MessageInjectionTargetUnavailableError(
            "The Pi Durable turn has ended.",
            "steering_closed",
          );
        }
        // The source read belongs to this synchronous submission, not its asynchronous receipt.
        return { outcome: input.submit(prompt, options) };
      });
      const placed = await outcome;
      if (placed === "closed") {
        throw new MessageInjectionTargetUnavailableError(
          "The Pi Durable turn has ended.",
          "steering_closed",
        );
      }
      if (placed === "withdrawn") {
        throw new MessageInjectionWithdrawnError(
          "Pi Durable withdrew the queued input.",
          "source_cancelled",
        );
      }
      if (placed === "unconfirmed") {
        return unconfirmed;
      }
      const recorder = options?.userTurnTranscriptRecorder;
      if (recorder) {
        try {
          // Pi now owns this exact input. Persistence uses the host's original input recorder.
          await recorder.confirmSteerTargetRunIdForPersistence?.(params.runId);
          recorder.markSentToProvider?.();
          await recorder.persistApproved();
          if (!recorder.hasPersisted()) {
            return unconfirmed;
          }
        } catch {
          return unconfirmed;
        }
      }
      return undefined;
    } finally {
      options?.onQueueSettled?.();
    }
  };

  const steering: Injection = {
    version: 2,
    isAvailable,
    queueMessage: (text, options, assertCurrent) => queueMessage(text, options, assertCurrent),
    queueMessageAsync: (text, options, preparation) =>
      queueMessage(text, options, preparation.assertCurrent, preparation.prepareCurrent),
  };
  return setActiveEmbeddedRun(
    params.sessionId,
    {
      kind: "embedded",
      runId: params.runId,
      startedAtMs: params.startedAtMs,
      terminalReplyExpectation: params.terminalReplyExpectation,
      toolAuthorityFingerprint: params.toolAuthorityFingerprint,
      isStreaming: isAvailable,
      isStopped: () => stop.signal.aborted,
      isAborted: () => stop.signal.aborted,
      ownsLiveness: isAvailable,
      isCompacting: () => false,
      supportsTranscriptCommitWait: true,
      supportsCrossProfileSteering: false,
      supportsQueueMessageImages: params.model.input.includes("image"),
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
      queueMessage: (text, options) => queueMessage(text, options, assertActive),
      messageInjectionV2: steering,
      abort: () => stop.abort(),
      cancel: () => stop.abort(),
    },
    params.sessionKey,
    params.sessionFile,
    params.agentId,
  );
}
