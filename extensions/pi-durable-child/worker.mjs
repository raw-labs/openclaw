import { parentPort, workerData } from "node:worker_threads";

const {
  BACKGROUND_CONTEXT,
  bool,
  CompactionTask,
  createAssistantMessageEventStream,
  createModels,
  createRegistry,
  defineDoc,
  defineExtension,
  defineSignal,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  InboxDoc,
  LiveDoc,
  obj,
  openNodeSqliteStorage,
  unsafe,
} = await import(new URL("./dist/pi-runtime.mjs", import.meta.url).href);

const port = parentPort;
if (!port) {
  throw new Error("Pi Durable requires a worker thread.");
}
const ctx = BACKGROUND_CONTEXT;
const { command, database } = workerData;
const decision = defineSignal({ name: "openclaw.approval", version: 1, schema: bool() });
const turn = defineDoc({
  kind: "openclaw.pi-turn",
  scope: "conversation",
  history: "latest",
  version: 1,
  initial: () => ({}),
  checkpointWhen: () => false,
});

let nextRequestId = 0;

// Compaction can overlap generation. Each request owns its replies; the worker
// sends transcript data and never handles credentials or a Gateway capability.
async function requestHost(request, onModelEvent) {
  const requestId = ++nextRequestId;
  const reply = new Promise((resolve) => {
    const receive = (message) => {
      if (message.requestId !== requestId) {
        return;
      }
      if (message.kind === "model-event") {
        onModelEvent?.(message.event);
        return;
      }
      port.off("message", receive);
      resolve(message);
    };
    port.on("message", receive);
  });
  port.postMessage({ kind: "request", requestId, request });
  const response = await reply;
  if (!response.ok) {
    throw new Error("OpenClaw refused the Pi Durable request.");
  }
  return response.value;
}

const wait = defineTool({
  name: "pi_durable_wait",
  description: "Ask for an approval decision and wait durably. Report the decision after resuming.",
  parameters: obj({}),
  replay: "safe",
  async execute(_args, api, context) {
    const answer = await api.readSignal(decision, "answer", context);
    if (answer && "value" in answer) {
      const checkedSession = answer.value ? await requestHost({ kind: "check-session" }) : false;
      return {
        output: [
          {
            type: "text",
            text: !answer.value
              ? "Approval denied."
              : checkedSession
                ? "Approval granted. Session verified."
                : "Approval granted.",
          },
        ],
        details: { approved: answer.value, checkedSession },
      };
    }
    const taskId = (await api.snapshot(turn, api.conversationId, context))?.taskId;
    if (taskId && taskId !== api.taskId) {
      return {
        output: [{ type: "text", text: "This turn has already requested an approval." }],
        isError: true,
      };
    }
    if (!taskId) {
      const admission = await requestHost({ kind: "admit", callId: api.callId });
      await api.commit(async (tx) => {
        const record = await tx.doc(turn, api.conversationId);
        record.taskId = api.taskId;
        record.approvalId = admission.id;
        if (admission.parent) {
          record.parent = admission.parent;
        }
      }, context);
    }
    return { sleep: { signals: [decision.key("answer")] } };
  },
});

function openClawContext({ messages }) {
  const system = [];
  const tools = new Map();
  const history = [];
  const sections = new Map();
  for (const message of messages) {
    if (message.role !== "system") {
      history.push(message);
      continue;
    }
    system.push(
      typeof message.content === "string"
        ? message.content
        : message.content.map(({ text }) => text).join("\n"),
    );
    for (const [name, text] of Object.entries(message.sections ?? {})) {
      if (text === null) {
        sections.delete(name);
      } else {
        sections.set(name, text);
      }
    }
    for (const { name } of message.toolsRemoved ?? []) {
      tools.delete(name);
    }
    for (const tool of message.toolsAdded ?? []) {
      tools.set(tool.name, tool);
    }
  }
  return {
    systemPrompt: [...system, ...sections.values()].filter(Boolean).join("\n\n"),
    messages: history,
    tools: [...tools.values()],
  };
}

function adaptModelProgress(stream) {
  let snapshot;
  return (event) => {
    if (event.partial) {
      snapshot = event.partial;
      stream.push(event);
      return;
    }
    if (event.type !== "text_delta" || !snapshot) {
      return;
    }
    const current = snapshot.content[event.contentIndex];
    if (current?.type !== "text") {
      return;
    }
    // OpenClaw emits compact text deltas. Pi Durable's stream checkpoints
    // consume cumulative partial messages, including on text deltas.
    const content = [...snapshot.content];
    content[event.contentIndex] = { ...current, text: current.text + event.delta };
    snapshot = { ...snapshot, content };
    stream.push({ ...event, partial: snapshot });
  };
}

function modelRequestError(model) {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
    stopReason: "error",
    errorMessage: "OpenClaw could not execute the Pi Durable model request.",
  };
}

async function run() {
  const registry = createRegistry();
  let pendingCompaction;
  let root;
  const reportCompaction = async () => {
    if (!pendingCompaction) {
      return false;
    }
    const { head, messages } = await root.context(ctx);
    if (head?.kind === "pi.compaction" && head.byTaskId === pendingCompaction.taskId) {
      const { count } = pendingCompaction;
      pendingCompaction = undefined;
      await requestHost({
        kind: "after-compaction",
        count,
        messages: openClawContext({ messages }).messages,
      });
      return true;
    }
    return false;
  };
  const installTools = (descriptors) => {
    const tools =
      descriptors === undefined
        ? [wait]
        : descriptors.map((tool) => {
            if (tool.name === wait.name) {
              return wait;
            }
            return defineTool({
              name: tool.name,
              description: tool.description,
              parameters: unsafe(tool.parameters),
              // No OpenClaw tool is assumed safe to repeat after an unknown outcome.
              replay: "unsafe",
              async execute(args, api) {
                return await requestHost({
                  kind: "tool",
                  name: tool.name,
                  args,
                  callId: api.callId,
                });
              },
            });
          });
    const hooks =
      command.action === "start" || command.action === "resume" || command.action === "compact"
        ? [
            hook(GenerationTask, {
              async onYield(answer) {
                const reason = await requestHost({ kind: "finalize", answer });
                return reason ? { continue: reason } : undefined;
              },
            }),
            hook(CompactionTask, {
              async beforeCompact({ messages, entries }, api) {
                await reportCompaction();
                pendingCompaction = { taskId: api.taskId, count: entries.length };
                await requestHost({
                  kind: "before-compaction",
                  messages: openClawContext({ messages }).messages,
                });
              },
            }),
          ]
        : [];
    registry.install(defineExtension({ name: "openclaw-wait", tools, hooks }));
  };
  let model =
    command.action === "start" || command.action === "compact" ? command.model : undefined;
  let becameIdle;
  let wakeTimer;
  let driving = false;
  let record;
  const handleWake = ({ active, at }) => {
    clearTimeout(wakeTimer);
    if (!driving) {
      return;
    }
    if (at !== undefined) {
      // onWake replaces Pi's own timer. An inference retry has a deadline,
      // whereas a parked approval needs an external signal.
      wakeTimer = setTimeout(() => harness.resume(), Math.max(1, at - Date.now()));
    } else if (!active) {
      becameIdle?.();
    }
  };
  const readOnly = command.action === "read-context" || command.action === "read-checkpoint";
  const harness = await Harness.open(
    await openNodeSqliteStorage(database),
    {
      readOnly,
      models: Object.assign(createModels(), {
        getModel(provider, id) {
          return model?.provider === provider && model.id === id ? model : undefined;
        },
        streamSimple(_model, context, { sessionId, reasoning }) {
          const stream = createAssistantMessageEventStream();
          void requestHost(
            {
              kind: "model",
              purpose: "generation",
              context: openClawContext(context),
              sessionId,
              reasoning,
            },
            adaptModelProgress(stream),
          )
            .then((message) => stream.end(message))
            .catch(() => stream.end(modelRequestError(model)));
          return stream;
        },
        async completeSimple(_model, context, { sessionId, reasoning, maxTokens }) {
          return await requestHost({
            kind: "model",
            purpose: "compaction",
            context: openClawContext(context),
            sessionId,
            reasoning,
            maxTokens,
          }).catch(() => modelRequestError(model));
        },
      }),
      registry,
      settings: { toolExecution: "sequential" },
      onWake: handleWake,
    },
    ctx,
  );
  try {
    root = await harness.root(ctx);
    if (command.action === "read-checkpoint") {
      const submission = await root.commit(
        (tx) => tx.submissionByRequest(root.id, command.runId),
        ctx,
      );
      if (submission?.status !== "done") {
        return { wait: { state: "missing" } };
      }
      const { head, messages } = await root.context(ctx, { at: submission.answer });
      return {
        wait: { state: "missing" },
        checkpoint: {
          at: submission.answer,
          ...(head ? { headKind: head.kind } : {}),
          messages: openClawContext({ messages }).messages,
        },
      };
    }
    if (command.action === "read-context") {
      const { messages } = await root.context(ctx);
      const excerpts = [];
      let remaining = command.maxChars;
      for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
        const message = messages[index];
        if (
          message.role !== "user" &&
          (message.role !== "assistant" || message.stopReason === "aborted")
        ) {
          continue;
        }
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n");
        if (text) {
          const excerpt = `${message.role}: ${text.slice(-remaining)}`;
          remaining -= excerpt.length;
          excerpts.push(excerpt);
        }
      }
      return { wait: { state: "missing" }, visibleContext: excerpts.toReversed().join("\n\n") };
    }
    record = await harness.snapshot(turn, root.id, ctx);
    installTools(command.action === "start" ? command.tools : record?.tools);
    if (command.action === "compact") {
      await root.configure({ model: { provider: model.provider, modelId: model.id } }, ctx);
      driving = true;
      const task = await root.compact(command.instructions, ctx);
      await harness.waitForTask(task, ctx);
      return { wait: { state: "missing" }, compacted: await reportCompaction() };
    }
    if (command.action === "start" && record?.runId !== command.runId) {
      if (record?.submissionId) {
        const previous = await harness.submission(record.submissionId, ctx);
        const settled = await previous.status(ctx);
        if (settled.status !== "done" && settled.status !== "unanswered") {
          return { wait: { state: "occupied" } };
        }
      }
      const seed = command.checkpoint?.messages ?? command.seed;
      if (seed?.length && !record?.forkHistorySeeded && !record?.submissionId) {
        // Pi requires submission table reads to precede entry writes. Commit the
        // fork history with its own marker so an interrupted startup can retry.
        await root.commit(async (tx) => {
          const data = await tx.doc(turn, root.id);
          for (const [index, message] of seed.entries()) {
            const checkpoint = index === 0 ? command.checkpoint : undefined;
            await tx.appendEntry(root.id, {
              kind: checkpoint ? "openclaw.fork-checkpoint" : "openclaw.fork-history",
              ...(checkpoint
                ? {
                    head: "self",
                    data: { at: checkpoint.at, sourceHeadKind: checkpoint.headKind ?? null },
                  }
                : {}),
              model: [message],
            });
          }
          data.forkHistorySeeded = true;
        }, ctx);
      }
      await root.configure(
        {
          model: { provider: model.provider, modelId: model.id },
          thinkingLevel: command.thinkingLevel,
          instructions: command.instructions || null,
        },
        ctx,
      );
      await root.commit(async (tx) => {
        const data = await tx.doc(turn, root.id);
        delete data.taskId;
        delete data.parent;
        delete data.approvalId;
        if (command.recovery) {
          data.recovery = command.recovery;
        } else {
          delete data.recovery;
        }
        data.model = command.model;
        data.route = command.route;
        data.tools = command.tools;
        data.runId = command.runId;
        data.submissionId = await root.submit(tx, {
          type: "input",
          content: command.images?.length
            ? [{ type: "text", text: command.prompt }, ...command.images]
            : command.prompt,
          requestId: command.runId,
        });
      }, ctx);
    }
    if (command.action === "cancel" && record?.submissionId) {
      const submission = await harness.submission(record.submissionId, ctx);
      const settled = await submission.status(ctx);
      if (settled.status !== "done" && settled.status !== "unanswered") {
        await root.abort(ctx);
      }
    }
    if (
      command.action === "resume" ||
      (command.action === "start" && record?.runId === command.runId)
    ) {
      // An unplaced steer belongs to a separate Gateway input admission. The
      // original turn's recovered source cannot spend that input on its behalf.
      const { items } = await harness.snapshot(InboxDoc, root.id, ctx);
      for (const item of items) {
        if (item.mode === "steer") {
          await (await harness.submission(item.id, ctx)).abort(ctx);
        }
      }
    }
    if (command.action === "resume") {
      model = record?.model;
    }
    let signal;
    if (command.action === "signal" && record?.taskId) {
      // Harness.signal() also starts the scheduler. This commit only writes the answer.
      signal = await harness.commit(
        (tx) => tx.signal(record.taskId, decision, "answer", command.approved),
        ctx,
      );
      if (signal !== "delivered" && signal !== "duplicate" && signal !== "closed") {
        throw new Error("Pi could not record the decision.");
      }
    }
    let closeInput;
    if (command.action === "start") {
      const { submissionId } = await harness.snapshot(turn, root.id, ctx);
      const pending = new Map();
      const report = (inputId, status) =>
        port.postMessage({ kind: "input-status", inputId, status });
      const observation = harness.observeCommits({
        advance({ changes }) {
          for (const change of changes) {
            if (change.type !== "submission" || change.value.conversationId !== root.id) {
              continue;
            }
            const inputId = pending.get(change.value.requestId);
            if (inputId === undefined || change.value.status === "queued") {
              continue;
            }
            pending.delete(change.value.requestId);
            report(inputId, change.value.entry ? "placed" : "withdrawn");
          }
        },
        end() {},
      });
      let commands = Promise.resolve();
      const receive = (message) => {
        if (message.kind !== "steer-input" && message.kind !== "withdraw-input") {
          return;
        }
        const { inputId } = message;
        const requestId = `openclaw.steer.${inputId}`;
        commands = commands
          .then(async () => {
            if (message.kind === "withdraw-input") {
              const input = await harness.commit(
                (tx) => tx.submissionByRequest(root.id, requestId),
                ctx,
              );
              if (input?.status === "queued") {
                await (await harness.submission(input.id, ctx)).abort(ctx);
              }
              return;
            }
            pending.set(requestId, inputId);
            const accepted = await root.commit(async (tx) => {
              const live = await tx.doc(LiveDoc, root.id);
              if (!live.run?.inputs.includes(submissionId)) {
                return false;
              }
              await root.submit(tx, {
                type: "input",
                content: message.images?.length
                  ? [{ type: "text", text: message.text }, ...message.images]
                  : message.text,
                requestId,
                whenBusy: "steer",
                whenIdle: "reject",
              });
              return true;
            }, ctx);
            if (!accepted) {
              pending.delete(requestId);
              report(inputId, "closed");
            } else if (pending.has(requestId)) {
              report(inputId, "queued");
            }
          })
          .catch(() => {
            pending.delete(requestId);
            report(inputId, "unconfirmed");
          });
      };
      port.on("message", receive);
      port.postMessage({ kind: "input-ready" });
      closeInput = async () => {
        port.off("message", receive);
        await commands;
        for (const inputId of pending.values()) {
          const input = await harness.commit(
            (tx) => tx.submissionByRequest(root.id, `openclaw.steer.${inputId}`),
            ctx,
          );
          if (input?.status === "queued") {
            await (await harness.submission(input.id, ctx)).abort(ctx);
          }
        }
        observation.detach();
      };
    }
    if (command.action === "start" || command.action === "resume") {
      const wake = harness.wake();
      if (wake.active || wake.at !== undefined) {
        const idle = new Promise((resolve) => {
          becameIdle = resolve;
        });
        driving = true;
        harness.resume();
        handleWake(harness.wake());
        await idle;
        await reportCompaction();
      }
    }
    await closeInput?.();
    record = await harness.snapshot(turn, root.id, ctx);
    if (!record?.submissionId) {
      return { wait: { state: "missing" } };
    }
    const submission = await harness.submission(record.submissionId, ctx);
    const settled = await submission.status(ctx);
    const receipt = {
      signal,
      recovery: record.recovery,
      runId: record.runId,
      approvalId: record.approvalId,
      hasApproval: record.taskId !== undefined,
      route: { ...record.route, api: record.model.api },
      parent: record.parent,
    };
    if (settled.status === "done") {
      const entry = await harness.commit((tx) => tx.entry(settled.answer), ctx);
      const assistant = entry?.model?.find((message) => message.role === "assistant");
      const text = assistant?.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
      if (!text) {
        return { ...receipt, wait: { state: "failed" } };
      }
      return { ...receipt, wait: { state: "completed", result: { text } }, assistant };
    }
    if (settled.status === "unanswered") {
      return { ...receipt, wait: { state: settled.reason === "aborted" ? "cancelled" : "failed" } };
    }
    const wake = harness.wake();
    return {
      ...receipt,
      wait: {
        state:
          wake.active || wake.at !== undefined ? "ready" : record.taskId ? "waiting" : "failed",
      },
    };
  } finally {
    driving = false;
    clearTimeout(wakeTimer);
    await harness.close(ctx);
  }
}

port.postMessage({ kind: "result", result: await run() });
