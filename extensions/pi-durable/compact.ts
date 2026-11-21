import { randomUUID } from "node:crypto";
import type {
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { completeSimple, type Model } from "openclaw/plugin-sdk/llm";
import { createPiTurnLifecycle } from "./turn-lifecycle.js";
import { piWorkerModel, runWorker } from "./worker-client.js";

export async function compactPiConversation(
  params: AgentHarnessCompactParams<2>,
  model: Model,
  path: string,
  serviceSignal: AbortSignal,
): Promise<AgentHarnessCompactResult> {
  const host = params.hostCapabilities;
  const source = host.retainSourceAuthority();
  const assertCurrent = () => {
    host.assertActive();
    source?.assertCurrent();
  };
  try {
    const binding = source?.bindModelExecution?.({ provider: model.provider, model: model.id });
    try {
      const signal = AbortSignal.any([
        serviceSignal,
        ...[params.abortSignal, source?.signal, binding?.signal].filter(
          (candidate): candidate is AbortSignal => candidate !== undefined,
        ),
      ]);
      const runId = params.runId ?? randomUUID();
      const lifecycle = createPiTurnLifecycle({
        ctx: {
          config: params.config,
          agentId: params.agentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          runId,
          modelProviderId: model.provider,
          modelId: model.id,
          memoryAudience: params.memoryAudience,
        },
        runId,
        sessionId: params.sessionId,
        provider: model.provider,
        model: model.id,
        sessionFile: params.sessionFile,
        assertCurrent,
      });
      const result = await runWorker(
        path,
        { action: "compact", model: piWorkerModel(model), instructions: params.customInstructions },
        signal,
        async (request) => {
          assertCurrent();
          if (request.kind === "before-compaction") {
            return await lifecycle.beforeCompaction(request.messages);
          }
          if (request.kind === "after-compaction") {
            return await lifecycle.afterCompaction(request.messages, request.count);
          }
          if (request.kind !== "model" || request.purpose !== "compaction") {
            throw new Error("Unexpected operation during Pi Durable compaction.");
          }
          lifecycle.modelInput(request.context, request.purpose);
          const reasoning =
            request.reasoning === "adaptive"
              ? "medium"
              : request.reasoning === "ultra"
                ? "max"
                : request.reasoning;
          const message = await completeSimple(
            model,
            request.context,
            {
              apiKey: params.resolvedApiKey,
              sessionId: params.sessionId,
              cacheRetention: "none",
              reasoning,
              maxTokens: request.maxTokens,
              signal,
            },
            () => {
              assertCurrent();
              binding?.assertCurrent();
            },
          );
          lifecycle.modelOutput(message);
          return message;
        },
      );
      return result.compacted
        ? { ok: true, compacted: true, compactionKind: "native-harness" }
        : { ok: false, compacted: false, reason: "Pi Durable did not commit a compaction." };
    } finally {
      binding?.release();
    }
  } finally {
    source?.release();
  }
}
