import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import type {
  AgentHarnessSessionDeletionMutation,
  AgentHarnessSessionDeletionParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createNativeSessionCommitFinalizer } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPiNodeCommand, createPiNodeInvokePolicy, PI_NODE_COMMAND } from "./node-command.js";
import { createService, PLUGIN_ID, recoveryApproval, TOOL, workId } from "./service.js";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Pi Durable child",
  description: "A detached Pi Durable wait resumed through current OpenClaw authority.",
  register(api) {
    api.registerNodeHostCommand(createPiNodeCommand());
    api.registerNodeInvokePolicy(createPiNodeInvokePolicy());
    const admissionBindings = new WeakSet<string[]>();
    const queues = new KeyedAsyncQueue();
    let run: ReturnType<typeof createService> | undefined;
    const requireService = () => {
      if (!run) {
        throw new Error("Pi Durable service is starting.");
      }
      return run;
    };
    async function retireSession<T>(
      params: AgentHarnessSessionDeletionParams,
      settle: (mutation: AgentHarnessSessionDeletionMutation) => Promise<T>,
    ): Promise<T> {
      params.assertCurrent();
      const service = run;
      const id = workId(params);
      let committed = false;
      const result = await settle(
        createNativeSessionCommitFinalizer({
          commit() {
            committed = true;
          },
          rollback() {},
        }),
      );
      if (committed) {
        await service?.retire(id);
      }
      return result;
    }
    const methodAccess = {
      scope: "operator.write",
      sessionAccess: { mode: "write", requiredTool: TOOL },
    } as const;

    api.registerGatewayMethod(
      "pi-durable-child.status",
      async (options) => {
        const authority = options.sessionAccessAuthority;
        if (!authority) {
          throw new Error("A current session is required.");
        }
        authority.assertCurrent();
        const id = workId(authority.target);
        const state = await requireService().status(id);
        authority.assertCurrent();
        return { id: state.approvalId ?? id, ...state.wait };
      },
      methodAccess,
    );

    api.registerGatewayMethod(
      `${PLUGIN_ID}.approval.resolve`,
      async (options) => {
        const authority = options.sessionAccessAuthority;
        const scopes = options.client?.connect.scopes ?? [];
        const { id, decision } = options.params;
        if (
          !authority ||
          options.client?.internal?.syntheticClient ||
          (!scopes.includes("operator.approvals") && !scopes.includes("operator.admin")) ||
          typeof id !== "string" ||
          !/^[a-f0-9]{64}(?:_[a-f0-9]{64})?$/.test(id) ||
          (decision !== "allow-once" && decision !== "deny")
        ) {
          throw new Error("A current approval reviewer and wait ID are required.");
        }
        const databaseId = id.split("_")[0]!;
        return queues.enqueue(databaseId, async () => {
          authority.assertCurrent();
          return await requireService().approve(
            databaseId,
            id,
            decision === "allow-once",
            authority,
            options.signal,
          );
        });
      },
      { scope: "operator.write", sessionAccess: { mode: "write" } },
    );

    api.registerService({
      id: PLUGIN_ID,
      apiVersion: 3,
      async start({ stateDir, scheduler, sessionWork }) {
        const directory = join(stateDir, "pi-durable-child");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        scheduler.signal.throwIfAborted();
        run = createService(api, directory, scheduler, sessionWork, queues, admissionBindings);
        await run.recover();
      },
      stop() {
        run = undefined;
      },
    });

    api.on("session_end", async (event, ctx) => {
      if (
        !ctx.agentId ||
        !event.sessionKey ||
        !event.nextSessionId ||
        (event.reason !== "reset" &&
          event.reason !== "new" &&
          event.reason !== "idle" &&
          event.reason !== "daily")
      ) {
        return;
      }
      await run?.retire(
        workId({
          agentId: ctx.agentId,
          sessionKey: event.sessionKey,
          sessionId: event.sessionId,
          lifecycleRevision: event.lifecycleRevision,
        }),
      );
    });

    const harness: AgentHarnessV2 = {
      id: PLUGIN_ID,
      label: "Pi Durable",
      autoSelection: { providerIds: [] },
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: { requiredNodeCommands: [PI_NODE_COMMAND], consumesWorkerSlot: false },
      },
      nativeModelPolicySupport: "exact",
      conversationToolPolicySupport: "exact",
      supportsTurnScopedToolRestrictions: true,
      mcpAppRuntimeOwner: "host",
      withSessionDeletion: retireSession,
      withSessionContextReset: retireSession,
      compact: (params) => requireService().compact(params),
      runSideQuestion: (params) => requireService().sideQuestion(params),
      supports: ({ modelProvider }) =>
        modelProvider?.nativeCommandAuth || modelProvider?.preparedAuth?.source === "harness"
          ? {
              supported: false,
              reason: "Pi Durable requires a model route authenticated by OpenClaw.",
            }
          : { supported: true },
      async withDescendantCancellation(params, stop) {
        return await stop(async () => ({
          killed:
            run && params.requesterTurnRunId === undefined
              ? Number(await run.cancel(workId(params), params.assertCurrent))
              : 0,
          cancelledRequesters: [],
        }));
      },
      async runAttempt(params) {
        const result = await requireService().start(params);
        const parked = result.wait.state === "waiting";
        const text = parked
          ? `Pi Durable is waiting for approval. Use /approve durable:${PLUGIN_ID}:${result.id} allow-once or deny in the parent chat.`
          : result.wait.state === "completed"
            ? result.wait.result.text
            : undefined;
        return {
          terminal:
            result.wait.state === "cancelled"
              ? { kind: "aborted", source: "external" }
              : text
                ? { kind: "ok" }
                : {
                    kind: "failed",
                    source: "prompt",
                    error: new Error(
                      result.wait.state === "occupied"
                        ? "This Pi Durable chat already has a turn in progress."
                        : "The Pi Durable turn ended without an answer or approval wait.",
                    ),
                  },
          assistantTexts: text ? [text] : [],
          assistantTranscriptOwned: result.transcript?.owned,
          assistantTranscriptIdempotencyKey: result.transcript?.idempotencyKey,
          finalPresentation: result.finalPresentation,
          lastAssistant: result.assistant,
          messagesSnapshot: result.assistant ? [result.assistant] : [],
          runtimeContinuationStarted: parked || undefined,
          toolMetas: [],
          cloudCodeAssistFormatError: false,
          didSendViaMessagingTool: false,
          itemLifecycle: { activeCount: 0, completedCount: 0, startedCount: 0 },
          messagingToolSentTexts: [],
          messagingToolSentTargets: [],
          messagingToolSentMediaUrls: [],
          sessionIdUsed: params.sessionId,
          sessionFileUsed: params.sessionFile,
          replayMetadata: {
            replaySafe: false,
            hadPotentialSideEffects: parked || result.executedTools,
          },
        };
      },
    };
    api.registerAgentHarness(harness);

    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => {
          return {
            name: TOOL,
            catalogMode: "direct-only",
            label: "Park Pi Durable child",
            description:
              "Wait for approval in a Pi Durable child. Create the child with sessions_spawn using visible=true and agentRuntime=pi-durable-child.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            async execute() {
              const { agentId, sessionKey, sessionId, runId } = context;
              context.assertInvocationCurrent();
              const recovered = recoveryApproval.getStore();
              if (
                recovered &&
                recovered.target.agentId === agentId &&
                recovered.target.sessionKey === sessionKey &&
                recovered.target.sessionId === sessionId
              ) {
                recovered.assertCurrent();
                return {
                  content: [{ type: "text", text: "Pi Durable approval wait admitted." }],
                  details: { id: recovered.id, parent: recovered.parent },
                };
              }
              // The definition can be inherited by a child under a restrictive parent allowlist.
              // Only the Pi harness may open the wait on its live attempt's tool surface.
              const delegatedTools = context.toolBindings?.[TOOL];
              if (
                !Array.isArray(delegatedTools) ||
                !admissionBindings.has(delegatedTools) ||
                !agentId ||
                !sessionKey ||
                !sessionId ||
                !runId
              ) {
                throw new Error("This tool requires an active Pi Durable child turn.");
              }
              const details = await requireService().admit({
                agentId,
                sessionKey,
                sessionId,
                runId,
                delegatedTools,
              });
              return {
                content: [{ type: "text", text: "Pi Durable approval wait admitted." }],
                details,
              };
            },
          };
        },
      },
      { names: [TOOL], workspaceAccess: false },
    );
  },
});
