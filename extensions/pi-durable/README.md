# Pi Durable harness

Pi Durable is an opt-in OpenClaw agent runtime. OpenClaw selects and authenticates the model, authorizes tools, and delivers replies. Pi persists a conversation per OpenClaw session generation. The conversation can take follow-up turns and use the session’s OpenClaw tools. Tools with an interrupted outcome are treated as unsafe to repeat automatically.

Pi Durable runs in Gateway-host workspaces and through OpenClaw’s sandbox tool surface. If the original caller has restart-recoverable OpenClaw authority, OpenClaw saves the prepared turn before starting Pi. A restart between that handoff and the first Pi commit recovers the original input. After a Pi commit, Pi’s journal owns replay. OpenClaw reauthorizes the caller and selected model after each restart.

Enable the bundled `pi-durable` plugin and select `pi-durable` as the runtime for a session using a provider route authenticated by OpenClaw. You can also set `agents.defaults.models["<provider>/<model>"].agentRuntime.id` to `pi-durable` to use it by default for that model. Send `/stop` to cancel an active or parked turn. A cancelled approval stays closed across restarts, and the chat can take new turns. Use `/compact` to summarize eligible history in an idle Pi Durable chat. Use `/btw` for a tool-free side question based on saved conversation text. Reset and deletion retire the corresponding Pi conversation generation after the OpenClaw change commits.

Use OpenClaw’s steer queue to add input to your active turn. Pi applies the input at the next eligible point between model and tool steps. The active turn can incorporate the new input into its reply.

Fork at a message using OpenClaw’s normal chat controls. A Pi Durable fork starts a new journal from Pi’s model checkpoint at the last completed Pi answer before the branch point. The checkpoint carries model-visible tool calls and results and any context summary at that point. The branch falls back to visible text when the source checkpoint is unavailable. Approvals and in-flight work remain with the source session.

In a Gateway chat, ask the parent to spawn a visible Pi Durable child for the task. The parent uses `sessions_spawn` with `visible: true`, `agentRuntime: "pi-durable"`, and `expectsCompletionMessage: false`. The durable child posts its own final result.

A child can call `pi_durable_wait` once per turn when it needs a decision. The Pi worker exits while the call waits, so the parent can keep chatting. The parent chat receives a notice with the exact `/approve ... allow-once` and `/approve ... deny` commands. Send the command in that parent chat with the usual operator approval scope. The same approval ID works after a Gateway restart. The command acknowledges after Pi commits the decision.

On wake, OpenClaw reauthorizes the original operator and selected model. The child can use its original tools after wake, subject to current OpenClaw policy. For a sandboxed turn, recovery reacquires the admitted workspace through the current sandbox owner. If that workspace cannot be recovered, the child cannot continue with host tools. When allowed, the approval tool also verifies the session through the read-only `session_status` tool. Pi supplies the result to the same model conversation. OpenClaw posts the final answer in both the parent and child transcripts.

On Gateway startup, Pi's stored wait and answer also drive notice recovery. OpenClaw reauthorizes the stored work before publishing to the original session generations. The same transcript keys make repeat publication safe, including when only one of the two result notices reached its chat before the crash.

## Place a session on a worker

Pi Durable uses OpenClaw’s `remote-exec` placement. Its journal and authenticated
model requests run on the Gateway. Workspace tools run on the selected worker.
For a paired device or node-backed cloud worker, enable the Pi Durable plugin
on the Gateway and the node, allow `pi-durable.workspace.exec.v1` in
`gateway.nodes.commands.allow`, and approve the node’s updated pairing
surface. The node command supports Linux and macOS workers with a POSIX shell
and Python 3. Select a worker or compatible profile in the session’s placement
picker.

The worker command uses OpenClaw’s placement-scoped approval and node-local
exec policy. Gateway restart clears the standing node approval. A subsequent
tool invocation can request approval again. The worker command runs with the
node account’s permissions. Sessions that require sandbox isolation use a
configured OpenClaw sandbox backend. Remote shell execution currently supports
noninteractive commands with bounded output.

When the Gateway restarts, OpenClaw settles any pending workspace result and
claims a fresh turn on the same placement before it resumes Pi. It waits for
that worker to reconnect or resume under the existing provider. Recovery
requires the original assignment and workspace to remain available. A
reassigned or retired placement blocks replay.

## Run the proof

The OpenClaw build packages the official Pi Durable source at revision
`eaa719f4c2bff51c5994f9c28c5395cddb4d0632`. Its runtime bundle is part of the
plugin distribution and needs no separate Pi installation. The build uses the
upstream lockfile and checks the source archive digest before compiling.

From the OpenClaw root:

```sh
pnpm test:e2e:gateway test/gateway-pi-durable.e2e.test.ts test/gateway-pi-durable-node.e2e.test.ts --maxWorkers=1
```

The test uses scripted provider servers and real Gateway processes. It kills the Gateway while the approval is parked, after the signal commits, during the recovered inference stream, and while a tool is executing. It also kills the Gateway during the first inference of an ordinary Pi chat, before an approval exists, and checks for one recovered reply. The recovered model request can retry after its Pi backoff. If a kill interrupts a tool after it starts, Pi records the uncertain outcome and gives it to the model without repeating the tool. The test checks that the parent can answer during recovery and that the interrupted preview stays out of committed chat history.

The worker test also starts a real paired node, puts a Pi Durable child on it,
and repeats the two approval kills using both direct device selection and a
worker profile backed by that node. While the node is offline after the second
kill, the parent still answers. The recovered child reads and executes in the
same worker workspace, and each chat receives one result.

## Live OpenAI proof

Create a disposable OpenClaw state directory and sign in with OpenClaw's normal OAuth flow. Run this from the OpenClaw root.

```sh
pi_auth_root=$(mktemp -d "${TMPDIR:-/tmp}/openclaw-pi-live-auth.XXXXXXXX")
mkdir "$pi_auth_root/home" "$pi_auth_root/state"
printf '%s\n' '{"plugins":{"allow":["openai"],"slots":{"memory":"none"}}}' > "$pi_auth_root/state/openclaw.json"
OPENCLAW_HOME="$pi_auth_root/home" \
  OPENCLAW_STATE_DIR="$pi_auth_root/state" \
  OPENCLAW_CONFIG_PATH="$pi_auth_root/state/openclaw.json" \
  pnpm openclaw models auth login --provider openai --method oauth --profile-id openai:pi-proof

OPENCLAW_LIVE_PI_DURABLE_AUTH_STATE="$pi_auth_root/state" \
  OPENCLAW_LIVE_PI_DURABLE_MODEL=openai/gpt-5.6-luna \
  pnpm test:live --no-quiet test/gateway-pi-durable.live.test.ts
```

Choose a model available to the signed-in account. The live test creates a child through the Gateway with an idle parent, runs the child on the real model, and sends `/approve` in the parent after recovery. It kills its isolated Gateway before the first Pi worker starts, after Pi parks, after approval commits, and after the child answer commits. The kills after parking and answer commit happen before the respective notice writes. Extra restarts exercise repeat publication and check that each chat still has exactly one copy of each expected notice.

To exercise the same approval flow with workspace tools, run
`test/gateway-pi-durable-workspace.live.test.ts` with the same disposable auth
and model settings. For Docker, set `DOCKER_HOST` to the engine socket and
`OPENCLAW_LIVE_PI_DURABLE_SANDBOX_IMAGE` to an installed OpenClaw sandbox image.
For SSH, set `OPENCLAW_LIVE_PI_DURABLE_SSH_CONFIG` to a JSON file with the SSH
sandbox settings for a disposable loopback target, including its identity and
known-hosts files. The fixture changes a file directly in the workspace between
Gateway processes. It checks the child reads the replacement after approval, the
parent keeps answering, both chats receive one result, and a fork can recall
tool output that never appeared in either chat's visible messages.

Foreground turns and recovered child turns stream through OpenClaw’s normal chat events. Recovered previews belong to the child chat, and its completed answer is published as a durable notice in both chats. With MCP Apps enabled, Pi Durable uses the Gateway’s session-owned MCP connections for both model tool calls and explicit App actions.

Pi Durable builds the model prompt from the workspace bootstrap files, persona, skills, current chat context, and OpenClaw prompt hooks. The harness runs tool, model, finalization, compaction, and end hooks at their corresponding boundaries. Foreground finalization can revise the answer or attach presentation through the standard OpenClaw hook. The host’s accepted-work record expires after seven days.
