---
summary: "Managed GitHub publication ownership, native authority, and recovery"
read_when:
  - Changing the GitHub publication provider or its native callers
  - Diagnosing publication withdrawal or uncertain remote effects
title: "GitHub publication lifecycle"
---

# GitHub publication lifecycle

GitHub publication runs through the bundled `github-repositories` account service.
The native `github_publish` tool and `sessions.github.*` requests retain their
existing session authorization. The plugin supplies GitHub policy and transport;
it cannot select a different session, database, checkpoint, or transcript owner.
See [GitHub integration](/plugins/github) for supported configuration and
[Feature plugins](/plugins/feature-plugins) for plugin lifecycle conventions.

## Start and admit

`extensions/github-repositories/src/lifecycle.ts` starts account maintenance,
installs the publication provider, and starts session review presentation under
the same managed plugin instance. The private
`src/plugin-sdk/repository-publication-install.ts` binding requires that instance,
its service scheduler, and the actual Gateway service lifetime. It admits the
provider's executable factory results rather than treating retained callbacks as
ordinary data. Publisher leases return to their creating provider through its
private identity map; replacement cannot adopt another provider's lease.

`src/gateway/workspace-publication-provider.ts` holds the current registration and
the native publication runtime. Native RPC handlers in
`src/gateway/server-methods/sessions-github.ts` resolve the current account service
and retain requester, connection, session, and workspace checks across awaits.
`src/gateway/github-publication-actions.ts` and
`src/gateway/github-pr-workspace-preparation.ts` retain source admission and local
workspace custody while delegating GitHub inspection and remote operations.
Disabling the whole plugin removes publication tools from newly constructed
native tool sets and withdraws the service. Disabling only public link readers
does not disable publication.

## Accept and execute

The native engine in `src/gateway/repository-publication-engine.ts` composes shared
worktree, personal, and repository-object publication. Existing native stores
retain idempotency keys, requester provenance, selected account and target,
checkpoint ownership, and effect receipts. No separate publication journal or
plugin database is introduced.

The provider in
`extensions/github-repositories/publication-provider-api.ts` prepares the exact
GitHub identity, target, PR inspection, preflight policy, content, and remote
operations. Its helpers reuse the existing repository metadata and remote API
owners. Credential renewal must preserve the selected source, profile, and
account; a replacement identity does not redirect an accepted publication.

For worktrees, `src/gateway/repository-publication-local-execution.ts` owns local
snapshot and index transitions. Repository-object execution uses immutable
checkpoint facts and blob reads without exposing checkpoint storage paths to the
plugin. Native one-use transfer owners authorize exact Git or worker credential
delivery. Remote effects are recorded before dispatch and observed before native
settlement; losing requester authority cannot pretend an accepted remote write
was undone.

Publication content reuses
`src/gateway/repository-publication-content.ts` for current attribution and sharing
facts. GitHub formatting remains in the plugin's existing content and transcript
formatters. Revoked sharing or credit consent is not replaced with a frozen copy.
`src/gateway/repository-publication-transcript.ts` selects the native transcript
owner and marks a report accepted only after the append succeeds.

## Withdraw, recover, and stop

Service withdrawal prevents new provider effects and retires captured service
APIs and executable leases. The Gateway retains accepted receipts and uncertain
writes independently of that registration. A later provider can reconcile only
the recorded original account, repository, branch, and request markers; it cannot
silently publish the request through its current replacement account. Personal
recovery still requires the original owner's current confirmation and connection
generation.

`src/gateway/repository-publication-service.ts` tracks native publication work and
recovery. Placement shutdown preserves its existing order: finish tracked
placement work, drain publication, then close workspace owners. Standalone
Gateway recovery uses the same native runtime, not a second plugin poller.

Worker publication authority remains in
`src/gateway/worker-environments/worker-github-binding.ts`: current session,
workspace, turn claim, and executable identity checks surround credential
refresh and one-use delivery. The demand cache in
`src/gateway/repository-publication-discovery.ts` belongs to one Gateway and never
warms the session corpus. Source checkout credentials are a separate capability.

## Diagnose a stopped or uncertain request

- If publication is unavailable, verify the whole plugin's enable, allow, and deny
  policy and its account-service startup. Re-enable it before retrying through the
  current Gateway service; retained handles remain retired.
- If an accepted effect has no definitive response, inspect its native status and
  use its supported retry or confirmation action. Do not change account or target
  to bypass the original request's selection.
- If requester, session, source, or workspace authority changed, restore access
  through its owning native workflow. The provider cannot grant that access.
- Keep test evidence scoped: local Git and native SQLite exercise local custody;
  synthetic GitHub responses do not prove live GitHub permissions or remote writes.
