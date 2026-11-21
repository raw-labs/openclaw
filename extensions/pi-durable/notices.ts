import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import { runAgentHarnessBeforeMessageWriteHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  OpenClawPluginApi,
  PluginServiceSessionWorkV1,
  PluginServiceSessionWorkContextV1,
} from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { appendSessionTranscriptMessageByIdentityStrict } from "openclaw/plugin-sdk/session-transcript-runtime";
import type { WorkerResult } from "./worker-client.js";

export type Target = Awaited<ReturnType<PluginServiceSessionWorkV1["admit"]>>["target"];
export type SessionGeneration = NonNullable<
  Awaited<ReturnType<OpenClawPluginApi["runtime"]["system"]["captureSessionGeneration"]>>
>;
export type PiTurnYield = {
  acknowledgment?: string;
  messageWaitRegistered?: boolean;
  resumesInPlace?: boolean;
};
export type WaitState =
  | { state: "missing" | "waiting" | "ready" | "failed" | "cancelled" | "occupied" }
  | ({ state: "yielded" } & PiTurnYield)
  | { state: "completed"; result: { text: string } };

export async function describePiSession(
  api: OpenClawPluginApi,
  agentId: string,
  sessionKey: string,
) {
  const { session } = await api.runtime.gateway.request<{
    session: {
      parentSessionKey?: string;
      forkSource?: { sessionKey: string; sessionId: string };
    } | null;
  }>("sessions.describe", { key: sessionKey, agentId });
  return session;
}

export async function capturePiParentGeneration(
  api: OpenClawPluginApi,
  agentId: string,
  sessionKey: string,
) {
  const parentKey = (await describePiSession(api, agentId, sessionKey))?.parentSessionKey;
  const parentAgent = parentKey && parseAgentSessionKey(parentKey)?.agentId;
  return parentKey && parentAgent
    ? await api.runtime.system.captureSessionGeneration({
        sessionKey: parentKey,
        agentId: parentAgent,
      })
    : undefined;
}

export function createPiDurableNoticePublisher(api: OpenClawPluginApi) {
  const postNotice = async (
    generation: SessionGeneration,
    id: string,
    type: "approval" | "completed",
    text: string,
    runId?: string,
  ) => {
    api.logger.info(`Publishing Pi Durable ${type} notice for ${id}`);
    const receipt = await api.runtime.system.postSessionNotice({
      generation,
      idempotencyKey: `${type}:${id}`,
      notice: { type, text, data: { id, ...(runId ? { runId } : {}) } },
    });
    if (receipt.status === "failed") {
      api.logger.warn(`Pi Durable child ${id} could not post its ${type} notice: ${receipt.error}`);
    }
    return receipt.status !== "failed";
  };
  return async (
    id: string,
    { wait, parent, runId }: Pick<WorkerResult, "wait" | "parent" | "runId">,
    assertCurrent: () => void,
    child?: Target,
  ) => {
    if (!parent) {
      return true;
    }
    if (wait.state === "waiting") {
      const approval = `durable:${api.id}:${id}`;
      assertCurrent();
      return await postNotice(
        parent,
        id,
        "approval",
        `Pi Durable child is waiting for your approval. Reply with /approve ${approval} allow-once or /approve ${approval} deny.`,
      );
    }
    if (wait.state === "completed" && child) {
      const generation = await api.runtime.system.captureSessionGeneration(child);
      let childPosted = true;
      if (
        generation?.sessionId === child.sessionId &&
        generation.lifecycleRevision === (child.lifecycleRevision ?? null)
      ) {
        assertCurrent();
        childPosted = await postNotice(generation, id, "completed", wait.result.text, runId);
      }
      assertCurrent();
      const parentPosted = await postNotice(parent, id, "completed", wait.result.text);
      return childPosted && parentPosted;
    }
    return true;
  };
}

/** Commit the native answer to the OpenClaw chat's own transcript generation. */
export async function mirrorPiDurableAnswer(
  params: Parameters<AgentHarnessV2["runAttempt"]>[0],
  generation: SessionGeneration,
  result: WorkerResult,
) {
  if (result.wait.state === "completed" && result.assistant && !result.hasApproval) {
    return await appendPiAnswer(result.assistant, generation, {
      config: params.config,
      runId: params.runId,
      assertCurrent: params.hostCapabilities.assertActive,
      prepare: params.prepareAssistantTranscriptMessage,
    });
  }
  return undefined;
}

export async function mirrorRecoveredPiAnswer(
  api: OpenClawPluginApi,
  current: PluginServiceSessionWorkContextV1,
  result: WorkerResult,
) {
  if (result.wait.state !== "completed" || !result.assistant || !result.runId) {
    return;
  }
  const generation = await api.runtime.system.captureSessionGeneration(current.target);
  if (
    !generation ||
    generation.sessionId !== current.target.sessionId ||
    generation.lifecycleRevision !== (current.target.lifecycleRevision ?? null)
  ) {
    throw new Error("The recovered Pi answer belongs to a retired session generation.");
  }
  await appendPiAnswer(result.assistant, generation, {
    config: api.runtime.config.current({ clone: true }),
    runId: result.runId,
    assertCurrent: current.assertCurrent,
  });
}

async function appendPiAnswer(
  answer: NonNullable<WorkerResult["assistant"]>,
  generation: SessionGeneration,
  options: {
    config?: Parameters<AgentHarnessV2["runAttempt"]>[0]["config"];
    runId: string;
    assertCurrent: () => void;
    prepare?: Parameters<AgentHarnessV2["runAttempt"]>[0]["prepareAssistantTranscriptMessage"];
  },
) {
  const key = `pi-durable:reply:${options.runId}`;
  const assistant = runAgentHarnessBeforeMessageWriteHook({
    message: structuredClone(answer),
    agentId: generation.agentId,
    sessionKey: generation.sessionKey,
    prepareAssistantTranscriptMessage: options.prepare,
  });
  if (!assistant) {
    return { owned: true };
  }
  const appended = await appendSessionTranscriptMessageByIdentityStrict({
    agentId: generation.agentId,
    sessionKey: generation.sessionKey,
    sessionId: generation.sessionId,
    storePath: generation.storePath,
    config: options.config,
    runId: options.runId,
    beforeFreshMessageCommit: options.assertCurrent,
    idempotencyLookup: "scan",
    updateMode: "inline",
    message: { ...assistant, idempotencyKey: key },
  });
  if (appended.kind !== "result") {
    throw new Error("Pi Durable could not publish the answer to this chat.");
  }
  return { owned: true, idempotencyKey: key, completedTurnSource: appended.result.anchor };
}
