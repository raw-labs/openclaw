import { formatGitHubPublicationTranscript } from "../../extensions/github-repositories/publication-transcript-api.js";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { getRuntimeConfig } from "../config/config.js";
import { appendSessionTranscriptReport } from "../config/sessions/session-accessor.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "../config/sessions/session-actor-storage-binding.js";
import { attachSessionTranscriptRunId } from "../sessions/transcript-events.js";
import type {
  GitHubPublicationCoordinator,
  GitHubPublicationTranscriptReport,
} from "./github-publication.js";

export async function reportGitHubPublicationTranscript(
  loadSessionRuntime: () => Promise<{
    resolveCanonicalSessionEntryFromStoreKeys: typeof import("./session-utils.js").resolveCanonicalSessionEntryFromStoreKeys;
    resolveGatewaySessionStoreTargetInWorker: typeof import("./session-utils-store-worker.js").resolveGatewaySessionStoreTargetInWorker;
  }>,
  coordinator: Pick<GitHubPublicationCoordinator, "markReportedAsync">,
  params: GitHubPublicationTranscriptReport,
): Promise<void> {
  const memory = captureSessionActorStorageOwner(params, {
    assertCurrent() {},
    authorize() {},
  });
  const selected = memory
    ? {
        target: {
          agentId: memory.agentId,
          canonicalKey: params.sessionKey,
          storePath: memory.path,
        },
        entry: readCapturedSessionActorEntry(memory, params.sessionKey),
      }
    : await (async () => {
        const runtime = await loadSessionRuntime();
        const target = await runtime.resolveGatewaySessionStoreTargetInWorker({
          cfg: getRuntimeConfig(),
          key: params.sessionKey,
          agentId: params.agentId,
        });
        return {
          target,
          entry: runtime.resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys),
        };
      })();
  const { target, entry } = selected;
  if (entry?.sessionId !== params.sessionId || target.canonicalKey !== params.sessionKey) {
    throw new Error("GitHub publication transcript owner changed");
  }
  const report = formatGitHubPublicationTranscript(params.result);
  const appended = await appendSessionTranscriptReport(
    {
      agentId: target.agentId,
      sessionId: params.sessionId,
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
    },
    {
      kind: "assistant",
      message: attachSessionTranscriptRunId(
        {
          role: "assistant",
          content: [{ type: "text", text: report.text }],
          api: "openai-responses",
          provider: "openclaw",
          model: "gateway-publication",
          responseId: report.responseId,
          usage: makeZeroUsageSnapshot(),
          stopReason: "stop",
          timestamp: Date.now(),
        },
        params.runId,
      ),
    },
  );
  if (!appended.ok) {
    throw new Error("GitHub publication transcript owner changed", { cause: appended.error });
  }
  await coordinator.markReportedAsync(params.result.requestId);
}
