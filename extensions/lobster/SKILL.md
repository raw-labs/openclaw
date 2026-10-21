# Lobster

Lobster executes multi-step workflows with approval checkpoints. Use it when:

- User wants a repeatable automation (triage, monitor, sync)
- Actions need human approval before executing (send, post, delete)
- Multiple tool calls should run as one repeatable operation

## When to use Lobster

| User intent                                            | Use Lobster?                                  |
| ------------------------------------------------------ | --------------------------------------------- |
| "Triage my email"                                      | Yes — multi-step, may send replies            |
| "Send a message"                                       | No — single action, use message tool directly |
| "Check my email every morning and ask before replying" | Yes — scheduled workflow with approval        |
| "What's the weather?"                                  | No — simple query                             |
| "Monitor this PR and notify me of changes"             | Yes — stateful, recurring                     |

## Basic usage

### Run a pipeline

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage"
}
```

Returns structured result:

```json
{
  "protocolVersion": 1,
  "ok": true,
  "status": "ok",
  "output": [{ "summary": {...}, "items": [...] }],
  "requiresApproval": null
}
```

### Handle approval

If the workflow needs approval:

```json
{
  "status": "needs_approval",
  "output": [],
  "requiresApproval": {
    "prompt": "Send 3 draft replies?",
    "items": [...],
    "resumeToken": "..."
  }
}
```

Present the prompt to the user. If they approve:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Rediscover a saved review

Use `list` with `status: "waiting"` to find pending runs in this conversation,
then `status` with `runId` to get pending wait IDs. Call `review` with `waitId`
to read the saved prompt, schema, defaults, and material the user must review.
Show that question to the user before requesting a decision. Do not infer approval
from discovery or a stored run status.

Resume with the reviewed `waitId` and its `expectedRevision`:

```json
{
  "action": "resume",
  "waitId": "<waitId>",
  "expectedRevision": 1,
  "approve": true
}
```

For input, send the user's answer as `responseJson` instead of `approve`. Use
`cancel: true` to cancel. A stale wait requires a fresh review. Existing `token`
and `approvalId` calls remain supported; older untracked tokens may not appear
in discovery. Caller association comes only from host context.

Do not automatically retry a run left `running` by a crash or a result with
`persistence_outcome_unknown`. Earlier external actions may already have happened.

## Example workflows

### Email triage

```
gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage
```

Fetches recent emails, classifies into buckets (needs_reply, needs_action, fyi).

### Email triage with approval gate

```
gog.gmail.search --query 'newer_than:1d' | email.triage | approve --prompt 'Process these?'
```

Same as above, but halts for approval before returning.

## Key behaviors

- **Deterministic**: Same input → same output (no LLM variance in pipeline execution)
- **Approval gates**: `approve` command halts execution, returns token
- **Resumable**: Use `resume` with a reviewed wait ID and revision, or an existing token, to continue
- **Discoverable**: Use `list`, `status`, and `review` after a restart; pending review context is saved independently of detailed history
- **Structured output**: Always returns JSON envelope with `protocolVersion`

## Don't use Lobster for

- Simple single-action requests (just use the tool directly)
- Queries that need LLM interpretation mid-flow
- One-off tasks that won't be repeated
