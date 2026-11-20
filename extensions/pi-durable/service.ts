import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import type { AgentHarnessCompactParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type {
  OpenClawPluginApi,
  PluginServiceSessionWorkV1,
} from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "openclaw/plugin-sdk/simple-completion-runtime";
import { compactPiConversation } from "./compact.js";
import { runForegroundPiTurn } from "./foreground-turn.js";
import { preparePiForkHistory } from "./fork-history.js";
import { createPiModelPreview } from "./live-model.js";
import { preparePiNodeWorkspace } from "./node-workspace.js";
import { createPiDurableNoticePublisher, mirrorRecoveredPiAnswer, type Target } from "./notices.js";
import { answerPiSideQuestion, type SideQuestion } from "./side-question.js";
import { createPiTurnLifecycle } from "./turn-lifecycle.js";
import { invokeRecoveredPiGatewayTool, toolFailure, toolOutput } from "./turn-tools.js";
import { runWorker, type PiStartCommand, type WorkerResult } from "./worker-client.js";

export const TOOL = "pi_durable_wait";
export const recoveryApproval = new AsyncLocalStorage<{
  target: Target;
  id: string;
  parent: NonNullable<WorkerResult["parent"]>;
  assertCurrent: () => void;
}>();
const CHECK_TOOL = "session_status";
const DATABASE_NAME = /^([a-f0-9]{64})\.sqlite$/;
const NOTICE_RETRY_MS = 5000;
const NOTICE_RETRIES = 4;

type Attempt = Parameters<AgentHarnessV2["runAttempt"]>[0];

export function workId(
  target: Omit<Target, "lifecycleRevision"> & { lifecycleRevision?: string | null },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        target.agentId,
        target.sessionKey,
        target.sessionId,
        target.lifecycleRevision ?? null,
      ]),
    )
    .digest("hex");
}

function approvalIdForTurn(databaseId: string, runId: string): string {
  return `${databaseId}_${createHash("sha256").update(runId).digest("hex")}`;
}

type Scheduler = import("openclaw/plugin-sdk/plugin-entry").PluginServiceSchedulerV1;

export function createService(
  api: OpenClawPluginApi,
  directory: string,
  scheduler: Scheduler,
  sessionWork: PluginServiceSessionWorkV1,
  queues: KeyedAsyncQueue,
  admissionBindings: WeakSet<string[]>,
) {
  const pending = api.runtime.state.openBlobStore<{ runId: string }>({
    namespace: "pending-turn-starts",
    maxEntries: 4096,
    maxBytesPerEntry: 32 * 1024 * 1024,
    maxBytesPerNamespace: 256 * 1024 * 1024,
    overflowPolicy: "reject-new",
    defaultTtlMs: 7 * 24 * 60 * 60_000,
  });
  const activeResumes = new Map<string, AbortController>();
  const database = (id: string) => join(directory, `${id}.sqlite`);
  const exists = async (id: string) => {
    try {
      return (await stat(database(id))).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  };
  const read = async (id: string): Promise<WorkerResult> =>
    (await exists(id))
      ? await runWorker(database(id), { action: "status" }, scheduler.signal)
      : { wait: { state: "missing" } };
  async function describeSession(agentId: string, sessionKey: string) {
    const { session } = await api.runtime.gateway.request<{
      session: {
        parentSessionKey?: string;
        forkSource?: { sessionKey: string; sessionId: string };
      } | null;
    }>("sessions.describe", { key: sessionKey, agentId });
    return session;
  }
  async function parentGeneration(agentId: string, sessionKey: string) {
    const parentKey = (await describeSession(agentId, sessionKey))?.parentSessionKey;
    const parentAgent = parentKey && parseAgentSessionKey(parentKey)?.agentId;
    return parentKey && parentAgent
      ? await api.runtime.system.captureSessionGeneration({
          sessionKey: parentKey,
          agentId: parentAgent,
        })
      : undefined;
  }
  const publishNotices = createPiDurableNoticePublisher(api);
  const schedule = (id: string, delayMs = 1000, noticeRetries = NOTICE_RETRIES) => {
    scheduler.schedule({
      id,
      delayMs,
      mode: "earliest",
      run: () =>
        queues.enqueue(id, async () => {
          const recorded = await read(id);
          const staged = await pending.lookup(id);
          const start =
            staged && staged.metadata.runId !== recorded.runId
              ? (JSON.parse(Buffer.from(staged.bytes).toString("utf8")) as PiStartCommand)
              : undefined;
          const wait = start ? { state: "ready" as const } : recorded.wait;
          const route = start ? { ...start.route, api: start.model.api } : recorded.route;
          const { parent } = recorded;
          const runId = start?.runId ?? recorded.runId;
          const recovery = start?.recovery ?? recorded.recovery;
          const approvalId =
            (!start && recorded.approvalId) || (runId ? approvalIdForTurn(id, runId) : id);
          const recoveryId = recovery?.id ?? approvalId;
          const hasNotices = parent && (wait.state === "waiting" || wait.state === "completed");
          const needsRecovery = recovery && (wait.state === "ready" || wait.state === "completed");
          if (
            !hasNotices &&
            !needsRecovery &&
            (wait.state !== "ready" || !route || !recorded.hasApproval)
          ) {
            if (staged && !start) {
              await pending.delete(id);
            }
            return;
          }
          let attemptedSignal: AbortSignal | undefined;
          const stop = new AbortController();
          if (wait.state === "ready") {
            activeResumes.set(id, stop);
          }
          const outcome = await sessionWork
            .run(recoveryId, async (current) => {
              attemptedSignal = current.signal;
              if (id !== workId(current.target)) {
                throw new Error("Pi Durable work belongs to a different session.");
              }
              if (staged && !start) {
                await pending.delete(id);
                current.assertCurrent();
              }
              if (wait.state !== "ready" || !route) {
                if (recorded.recovery && !recorded.hasApproval) {
                  await mirrorRecoveredPiAnswer(api, current, recorded);
                  return true;
                }
                const posted = await publishNotices(
                  approvalId,
                  recorded,
                  current.assertCurrent,
                  current.target,
                );
                if (posted) {
                  api.logger.info(`Reconciled Pi Durable ${wait.state} notices for ${approvalId}`);
                }
                return posted;
              }
              const recoveredRunId = runId ?? approvalId;
              const { provider, modelId, profileId } = route;
              using stream = current.openAssistantPreview();
              const nextPreview = createPiModelPreview(
                { runId: recoveredRunId },
                api.logger,
                (chunk) => stream.publish(chunk),
              );
              const lifecycle = createPiTurnLifecycle({
                runId: recoveredRunId,
                sessionId: current.target.sessionId,
                provider,
                model: modelId,
                sessionFile: database(id),
                ctx: {
                  ...current.target,
                  runId: recoveredRunId,
                  modelProviderId: provider,
                  modelId,
                },
                assertCurrent: current.assertCurrent,
              });
              let beganInference = false;
              const result = await current.withWorkspaceExecution(
                {
                  model: { provider, model: modelId },
                  runId: recoveredRunId,
                  signal: stop.signal,
                  prepareNodeWorkspace: (sandbox, signal, assertCurrent) =>
                    preparePiNodeWorkspace(api, sandbox, signal, assertCurrent),
                },
                (workspace, signal) =>
                  runWorker(
                    database(id),
                    start ?? { action: "resume" },
                    signal,
                    async (request, progress) => {
                      signal.throwIfAborted();
                      current.assertCurrent();
                      if (request.kind === "finalize") {
                        return await lifecycle.finalize(request.answer);
                      }
                      if (request.kind === "before-compaction") {
                        return await lifecycle.beforeCompaction(request.messages);
                      }
                      if (request.kind === "after-compaction") {
                        return await lifecycle.afterCompaction(request.messages, request.count);
                      }
                      if (request.kind === "check-session" || request.kind === "tool") {
                        const name = request.kind === "tool" ? request.name : CHECK_TOOL;
                        const args = request.kind === "tool" ? request.args : {};
                        try {
                          const toolResult = workspace
                            ? await workspace.invoke({
                                name,
                                callId:
                                  request.kind === "tool"
                                    ? request.callId
                                    : `${recoveredRunId}:verify`,
                                args,
                                signal,
                              })
                            : await invokeRecoveredPiGatewayTool(
                                api,
                                current.target,
                                name,
                                args,
                                signal,
                              );
                          return request.kind === "check-session"
                            ? true
                            : toolOutput(toolResult.content);
                        } catch (error) {
                          current.assertCurrent();
                          if (request.kind === "check-session") {
                            return false;
                          }
                          return toolFailure(error);
                        }
                      }
                      if (request.kind === "admit") {
                        const savedParent = recovery?.parent;
                        if (!savedParent || (!start && recorded.hasApproval)) {
                          throw new Error(
                            "A recovered Pi approval requires its original current parent.",
                          );
                        }
                        const liveParent =
                          await api.runtime.system.captureSessionGeneration(savedParent);
                        if (!liveParent || workId(liveParent) !== workId(savedParent)) {
                          throw new Error("The original Pi Durable parent has changed.");
                        }
                        current.assertCurrent();
                        await recoveryApproval.run(
                          {
                            target: current.target,
                            id: approvalId,
                            parent: liveParent,
                            assertCurrent: current.assertCurrent,
                          },
                          () => invokeRecoveredPiGatewayTool(api, current.target, TOOL, {}, signal),
                        );
                        current.assertCurrent();
                        return { id: approvalId, parent: liveParent };
                      }
                      if (request.kind !== "model") {
                        throw new Error("Unsupported recovered Pi work operation.");
                      }
                      return await current.withModelExecution(
                        { provider, model: modelId },
                        async (execution) => {
                          const modelSignal = AbortSignal.any([execution.signal, stop.signal]);
                          const cfg = api.runtime.config.current({ clone: true });
                          const modelRef = `${provider}/${modelId}${profileId ? `@${profileId}` : ""}`;
                          const prepared = await prepareSimpleCompletionModelForAgent({
                            cfg,
                            agentId: current.target.agentId,
                            modelRef,
                            signal: modelSignal,
                          });
                          if (
                            "error" in prepared ||
                            prepared.selection.provider !== provider ||
                            prepared.selection.modelId !== modelId ||
                            prepared.auth.profileId !== profileId ||
                            prepared.model.api !== route.api
                          ) {
                            throw new Error("The original Pi Durable model route is unavailable.");
                          }
                          execution.assertCurrent();
                          if (!beganInference && request.purpose === "generation") {
                            beganInference = true;
                            api.logger.info(`Resuming Pi Durable turn ${approvalId}`);
                          }
                          lifecycle.modelInput(request.context, request.purpose);
                          const preview =
                            request.purpose === "generation" ? nextPreview() : undefined;
                          const response = await completeWithPreparedSimpleCompletionModel({
                            model: prepared.model,
                            auth: prepared.auth,
                            context: request.context,
                            cfg,
                            assertCurrent: execution.assertCurrent,
                            onEvent: preview
                              ? async (event) => {
                                  progress(event);
                                  await preview(event);
                                }
                              : undefined,
                            options: {
                              sessionId: request.sessionId,
                              maxTokens: request.maxTokens,
                              ...(request.purpose === "compaction"
                                ? { cacheRetention: "none" }
                                : {}),
                              reasoning: request.reasoning,
                              signal: modelSignal,
                            },
                          });
                          lifecycle.modelOutput(response);
                          return response;
                        },
                      );
                    },
                  ),
              );
              current.assertCurrent();
              if (start && result.runId === start.runId) {
                await pending.delete(id);
                current.assertCurrent();
              }
              await lifecycle.end(result.wait.state === "completed", result.assistant);
              current.assertCurrent();
              if (result.recovery && !result.hasApproval) {
                await mirrorRecoveredPiAnswer(api, current, result);
              }
              const posted = await publishNotices(
                approvalId,
                result,
                current.assertCurrent,
                current.target,
              );
              api.logger.info(`Pi Durable turn ${approvalId} settled as ${result.wait.state}`);
              return posted;
            })
            .catch((error: unknown) => {
              if (stop.signal.aborted) {
                return undefined;
              }
              if (!attemptedSignal?.aborted || scheduler.signal.aborted || noticeRetries === 0) {
                throw error;
              }
              // Reopen Pi's committed state under a fresh borrow when startup makes
              // session access temporarily unavailable. Pi owns tool replay decisions.
              schedule(id, NOTICE_RETRY_MS, noticeRetries - 1);
              return undefined;
            })
            .finally(() => activeResumes.delete(id));
          if (!outcome) {
            return;
          }
          if (outcome.status === "unavailable") {
            api.logger.warn(`Pi Durable work ${id}: ${outcome.reason}`);
            if (outcome.retryAfterMs !== undefined) {
              schedule(id, outcome.retryAfterMs, noticeRetries);
            } else if (staged) {
              await pending.delete(id);
            }
          } else if (!outcome.value && noticeRetries > 0) {
            schedule(id, NOTICE_RETRY_MS, noticeRetries - 1);
          }
        }),
    });
  };
  return {
    async recover() {
      for (const entry of await pending.entries()) {
        schedule(entry.key);
      }
      for (const name of await readdir(directory)) {
        const id = DATABASE_NAME.exec(name)?.[1];
        if (id) {
          // Pi owns the replay facts. Reuse the original transcript keys for
          // both missing notices and writes that already reached either chat.
          schedule(id);
        }
      }
    },
    status: (id: string) => queues.enqueue(id, () => read(id)),
    async retire(id: string) {
      activeResumes.get(id)?.abort();
      await queues.enqueue(id, async () => {
        await pending.delete(id);
        const path = database(id);
        for (const suffix of ["-wal", "-shm", "-journal", ""]) {
          await rm(path + suffix, { force: true });
        }
      });
    },
    async sideQuestion(params: SideQuestion) {
      const { agentId, sessionKey, runtimeModel } = params;
      if (!agentId || !sessionKey || !runtimeModel) {
        throw new Error("Pi Durable side questions require an admitted Gateway session and model.");
      }
      params.hostCapabilities.assertActive();
      const generation = await api.runtime.system.captureSessionGeneration({ agentId, sessionKey });
      if (!generation || generation.sessionId !== params.sessionId) {
        throw new Error("The Pi Durable session changed.");
      }
      const id = workId(generation);
      return await answerPiSideQuestion(
        params,
        runtimeModel,
        (await exists(id)) ? database(id) : undefined,
        scheduler.signal,
      );
    },
    async compact(
      params: AgentHarnessCompactParams &
        Partial<Pick<AgentHarnessCompactParams<2>, "hostCapabilities">>,
    ) {
      const { agentId, sessionKey, runtimeModel, hostCapabilities: host } = params;
      if (
        !agentId ||
        !sessionKey ||
        !runtimeModel ||
        host?.kind !== "agent-harness-host-capability" ||
        host.version !== 1 ||
        typeof host.retainSourceAuthority !== "function"
      ) {
        return {
          ok: false,
          compacted: false,
          reason: "Pi Durable compaction requires an admitted Gateway session and model.",
        };
      }
      host.assertActive();
      const generation = await api.runtime.system.captureSessionGeneration({ agentId, sessionKey });
      if (!generation || generation.sessionId !== params.sessionId) {
        return { ok: false, compacted: false, reason: "The Pi Durable session changed." };
      }
      const id = workId(generation);
      return await queues.enqueue(id, async () => {
        host.assertActive();
        const prior = await read(id);
        if (
          prior.wait.state === "missing" ||
          prior.wait.state === "waiting" ||
          prior.wait.state === "ready"
        ) {
          return {
            ok: true,
            compacted: false,
            reason: "No idle Pi Durable conversation to compact.",
          };
        }
        return await compactPiConversation(
          { ...params, hostCapabilities: host },
          runtimeModel,
          database(id),
          scheduler.signal,
        );
      });
    },
    async cancel(id: string, assertCurrent: () => void) {
      assertCurrent();
      activeResumes.get(id)?.abort();
      return await queues.enqueue(id, async () => {
        const cancelledStart = await pending.delete(id);
        const { wait } = await read(id);
        assertCurrent();
        if (wait.state !== "waiting" && wait.state !== "ready") {
          return cancelledStart;
        }
        const result = await runWorker(database(id), { action: "cancel" }, scheduler.signal);
        return result.wait.state === "cancelled";
      });
    },
    async approve(
      id: string,
      approvalId: string,
      approved: boolean,
      reviewer: { target: Target; assertCurrent: () => void },
      signal?: AbortSignal,
    ) {
      const { parent, approvalId: currentApprovalId, recovery } = await read(id);
      reviewer.assertCurrent();
      if ((currentApprovalId ?? id) !== approvalId) {
        throw new Error("The Pi Durable approval has closed.");
      }
      if (!parent || workId(parent) !== workId(reviewer.target)) {
        throw new Error("This approval belongs to a different parent chat.");
      }
      const outcome = await sessionWork.run(recovery?.id ?? approvalId, async (current) => {
        reviewer.assertCurrent();
        current.assertCurrent();
        return await runWorker(
          database(id),
          { action: "signal", approved },
          AbortSignal.any(
            signal
              ? [signal, current.signal, scheduler.signal]
              : [current.signal, scheduler.signal],
          ),
        );
      });
      if (outcome.status !== "completed" || outcome.value.signal !== "delivered") {
        throw new Error("The Pi Durable approval has closed.");
      }
      if (outcome.value.wait.state === "ready") {
        schedule(id);
      }
      return { status: outcome.value.signal };
    },
    async admit({
      agentId,
      sessionKey,
      sessionId,
      runId,
      delegatedTools,
    }: Omit<Target, "lifecycleRevision"> & { runId: string; delegatedTools: string[] }) {
      const invocation = { agentId, sessionKey, toolName: TOOL };
      const expected = await sessionWork.withCurrent(invocation, async ({ target }) => target);
      if (expected.sessionId !== sessionId) {
        throw new Error("The child session changed before the wait was admitted.");
      }
      const parent = await parentGeneration(agentId, sessionKey);
      if (!parent) {
        throw new Error("Pi Durable approval requires a current parent chat.");
      }
      const databaseId = workId(expected);
      const id = approvalIdForTurn(databaseId, runId);
      const admission = await sessionWork.admit({
        ...invocation,
        id,
        delegatedTools,
      });
      if (!admission.recoverable || workId(admission.target) !== databaseId) {
        throw new Error("Pi Durable requires a restart-recoverable caller for this child session.");
      }
      return { id, parent };
    },
    async start(params: Attempt) {
      const { agentId, sessionKey, sessionId, hostCapabilities: host } = params;
      if (!agentId || !sessionKey) {
        throw new Error("Pi Durable requires a Gateway session.");
      }
      host.assertActive();
      const generation = await api.runtime.system.captureSessionGeneration({ agentId, sessionKey });
      if (!generation || generation.sessionId !== sessionId) {
        throw new Error("Pi Durable could not find this active session.");
      }
      const id = workId(generation);
      return await queues.enqueue(id, async () => {
        host.assertActive();
        const previous = await read(id);
        if ((previous.parent || previous.recovery) && previous.wait.state === "completed") {
          const previousApprovalId = previous.approvalId ?? id;
          const published = await sessionWork.run(
            previous.recovery?.id ?? previousApprovalId,
            async (current) => {
              if (previous.recovery && !previous.hasApproval) {
                await mirrorRecoveredPiAnswer(api, current, previous);
                return true;
              }
              return publishNotices(
                previousApprovalId,
                previous,
                current.assertCurrent,
                current.target,
              );
            },
          );
          if (
            published.status === "completed"
              ? !published.value
              : published.retryAfterMs !== undefined
          ) {
            schedule(id, NOTICE_RETRY_MS);
            throw new Error(
              "The previous Pi Durable result is still being published. Retry this turn.",
            );
          }
        }
        const delegatedTools: string[] = [];
        admissionBindings.add(delegatedTools);
        const fork =
          previous.wait.state === "missing"
            ? (await describeSession(agentId, sessionKey))?.forkSource
            : undefined;
        const history = fork ? await preparePiForkHistory(params, generation) : undefined;
        const sourceAgent =
          fork && history?.nativeRunId && parseAgentSessionKey(fork.sessionKey)?.agentId;
        const source =
          sourceAgent &&
          (await api.runtime.system.captureSessionGeneration({
            agentId: sourceAgent,
            sessionKey: fork.sessionKey,
          }));
        let checkpoint: PiStartCommand["checkpoint"];
        if (source && source.sessionId === fork?.sessionId && history?.nativeRunId) {
          const sourceId = workId(source);
          const runId = history.nativeRunId;
          if (sourceId !== id) {
            checkpoint = await queues.enqueue(sourceId, async () => {
              host.assertActive();
              return (await exists(sourceId))
                ? (
                    await runWorker(
                      database(sourceId),
                      { action: "read-checkpoint", runId },
                      scheduler.signal,
                    )
                  ).checkpoint
                : undefined;
            });
          }
        }
        host.assertActive();
        let staged = false;
        let result: Awaited<ReturnType<typeof runForegroundPiTurn>>;
        try {
          result = await runForegroundPiTurn({
            attempt: params,
            api,
            generation,
            databasePath: database(id),
            seed: checkpoint ? undefined : history?.seed,
            checkpoint,
            serviceSignal: scheduler.signal,
            log: api.logger,
            approvalTool: TOOL,
            turnApprovalId: approvalIdForTurn(id, params.runId),
            delegatedTools,
            async admitStart(command) {
              const toolNames = command.tools.map(({ name }) => name);
              const recoveryId = `turn:${approvalIdForTurn(id, params.runId)}`;
              const admitted = await sessionWork.admitTurn?.({
                id: recoveryId,
                source: host,
                toolNames,
              });
              if (!admitted?.recoverable) {
                return command;
              }
              if (workId(admitted.target) !== id) {
                throw new Error("Pi Durable turn admission changed conversation.");
              }
              const parent = toolNames.includes(TOOL)
                ? await parentGeneration(agentId, sessionKey)
                : undefined;
              host.assertActive();
              const start = {
                ...command,
                recovery: { id: recoveryId, ...(parent ? { parent } : {}) },
              };
              if (
                !(await pending.registerIfAbsent(id, Buffer.from(JSON.stringify(start)), {
                  runId: start.runId,
                }))
              ) {
                schedule(id);
                throw new Error("An earlier Pi Durable input is awaiting journal admission.");
              }
              staged = true;
              host.assertActive();
              return start;
            },
            async cancelInterrupted() {
              if (await exists(id)) {
                await runWorker(database(id), { action: "cancel" }, scheduler.signal);
              }
            },
          });
        } finally {
          if (staged && !scheduler.signal.aborted) {
            await pending.delete(id);
          }
        }
        const operationId = result.approvalId ?? id;
        if (!(await publishNotices(operationId, result, host.assertActive))) {
          schedule(id, NOTICE_RETRY_MS, NOTICE_RETRIES - 1);
        }
        return { id: operationId, ...result };
      });
    },
  };
}
