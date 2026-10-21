# Lobster (plugin)

Adds the `lobster` agent tool as an **optional** plugin tool.

## Install

```bash
openclaw plugins install @openclaw/lobster
```

Restart the Gateway after installing or updating the plugin.

### RAW Labs source checkout

This branch pins the engine to RAW Labs commit
`53b270b15cb525cca1458fb387d63621c1e2c7a9`, rather than the registry release.
Run `pnpm install --frozen-lockfile` at the workspace root. The lockfile records
that exact source and integrity; preparation is allowed only for that source and
runs the engine's build before use. No sibling checkout or unpublished local
artifact is required. This source integration has not been published to npm.
The dependency pin, lock entry, and preparation allowlist are separate from the
reusable plugin integration commit.

## What this is

- Lobster is a standalone workflow shell (typed JSON-first pipelines + approval/input checkpoints).
- This plugin integrates Lobster with OpenClaw _without core changes_.
- Input checkpoints return the question and schema; resume with `responseJson` containing the user's answer as JSON. See [structured input](https://docs.openclaw.ai/tools/lobster#structured-input).
- New runs retain their status and complete pending review context in the Lobster store. The next authorized turn can rediscover waiting runs after a Gateway restart.

## Enable

Because this tool can trigger side effects (via workflows), it is registered with `optional: true`.

Enable it in an agent allowlist:

```json
{
  "agents": {
    "entries": {
      "main": {
        "default": true,
        "tools": {
          "allow": [
            "lobster" // plugin id (enables all tools from this plugin)
          ]
        }
      }
    }
  }
}
```

## Durable state and reviews

The default file backend keeps existing checkpoints usable. Run tracking is enabled
for calls with a trusted host agent and logical session key; detailed history is
off by default. Detailed step/event history is inspected with the engine CLI;
the plugin's `status` action returns a run summary and pending waits. The plugin
derives the caller association from that host context,
never from tool arguments. It follows the logical conversation across Gateway
restarts and `/new` or `/reset`; it is conversation scoped, not a separate user
authentication system.

Optional plugin configuration:

```json
{
  "plugins": {
    "entries": {
      "lobster": {
        "config": {
          "directory": "/path/to/lobster-state",
          "backend": "files",
          "history": false
        }
      }
    }
  }
}
```

Omit `directory` to preserve `LOBSTER_STATE_DIR` and the engine's default state
location. Omit `backend` to honor the store's selection or `LOBSTER_BACKEND`,
otherwise files. SQLite is opt-in and runs in the engine's worker. The engine
checks that worker's actual SQLite version and rejects versions affected by the
WAL-reset bug. Upgrade the runtime or use a patched SQLite library if rejected;
the file backend is unaffected. SQLite stores runtime state, checkpoints, and run
records; workflow definitions remain files.
An existing file store requires explicit offline migration with the matching
Lobster CLI after all writers have stopped:

```bash
LOBSTER_STATE_DIR=/path/to/lobster-state lobster storage migrate sqlite --offline
```

The plugin never migrates or prunes a store automatically. Migration preserves
existing records; it cannot recreate absent history. A backend mismatch leaves
the existing store authoritative and returns an error. Each operation owns a
store session, waits for accepted engine work to settle, and closes the session.
No background process waits for a user's answer.

Use the same `lobster` tool to discover and answer a saved review:

```json
{ "action": "list", "status": "waiting", "limit": 20 }
{ "action": "status", "runId": "<runId>" }
{ "action": "review", "waitId": "<pendingWaitId>" }
{ "action": "resume", "waitId": "<pendingWaitId>", "expectedRevision": 1, "approve": true }
```

`list` supports `after`/`nextCursor` pagination and run status filters. `status`
returns pending wait IDs. `review` returns the saved prompt, schema, defaults,
and review subject; show it to the user before submitting a decision.
`expectedRevision` comes from `review` and refers to the wait, not the run.
For input, use `responseJson` instead of `approve`; use `cancel: true` to cancel.
A stale or consumed wait returns `wait_conflict` without repeating the action.
Saved questions are subject to the tool output cap (at most 2,000,000 bytes) and
remain stored if rendering fails. The error retains the run ID for discovery.
Inspect larger questions privately with the engine CLI.

On a later turn, the plugin appends at most five waiting run IDs to the current
request when Lobster is available to that unsandboxed conversation. It leaves the
system prompt and past messages intact. Review material is read only through an
explicit `review` call and returned through the current conversation's normal
tool response. The plugin does not send unsolicited channel messages at startup.
Calls without a stable host identity can still run and use legacy bearer tokens,
but cannot list, inspect, or resume by wait ID.

Existing tokens and approval IDs retain their bearer semantics. A legacy checkpoint
first associated during token resume may have partial history and no caller; it
stays outside conversation-scoped discovery. An operator can explicitly inventory
and adopt a saved checkpoint with the matching engine CLI:

```bash
LOBSTER_STATE_DIR=/path/to/lobster-state lobster storage legacy list
LOBSTER_STATE_DIR=/path/to/lobster-state lobster storage legacy adopt <checkpointId> --caller <trustedCallerId>
```

The caller ID must match the plugin's SHA-256 hash of the JSON array
`[agentId, sessionKey]`, derived from trusted host context. Adoption preserves old
tokens and does not execute steps, fabricate missing history, or reassign an
existing owner. The plugin does not infer ownership or expose adoption to model
arguments.

A stored pause can be resumed after restart. A run interrupted during a side effect
is not automatically replayed. `running` is the last stored status, not proof of a
live worker. Persistence errors retain their structured type, run ID, and operation
ID, including `persistence_outcome_unknown`; an unknown outcome requires operator
reconciliation, not an automatic retry.

## Using `openclaw.invoke` (Lobster → OpenClaw tools)

Some Lobster pipelines may include a `openclaw.invoke` step to call back into OpenClaw tools/plugins (for example: `gog` for Google Workspace, `gh` for GitHub, `message.send`, etc.).

For this to work, the OpenClaw Gateway must expose the tool bridge endpoint and the target tool must be allowed by policy:

- OpenClaw provides an HTTP endpoint: `POST /tools/invoke`.
- The request is gated by **gateway auth** (e.g. `Authorization: Bearer …` when token auth is enabled).
- The invoked tool is gated by **tool policy** (global + per-agent + provider + group policy). If the tool is not allowed, OpenClaw returns `404 Tool not available`.

### Allowlisting recommended

To avoid letting workflows call arbitrary tools, set a tight allowlist on the agent that will be used by `openclaw.invoke`.

Example (allow only a small set of tools):

```jsonc
{
  "agents": {
    "entries": {
      "main": {
        "default": true,
        "tools": {
          "allow": ["lobster", "web_fetch", "web_search", "gog", "gh"],
          "deny": ["gateway"],
        },
      },
    },
  },
}
```

Notes:

- If `tools.allow` is omitted or empty, it behaves like "allow everything (except denied)". For a real allowlist, set a **non-empty** `allow`.
- Tool names depend on which plugins you have installed/enabled.

## Security

- Runs Lobster in process via its declared `@clawdbot/lobster/core` runtime dependency.
- Does not manage OAuth/tokens.
- Uses timeouts, stdout caps, and strict JSON envelope parsing.

## Docs

- https://docs.openclaw.ai/tools/lobster

## Package

- Plugin id: `lobster`
- Tool: `lobster`
- Package: `@openclaw/lobster`
- Minimum OpenClaw host: `2026.4.25`
