# GitHub Settings and repository artifacts

This plugin owns Profile → GitHub connections and the GitHub identity view in
Agent → Tools. The plugin owns the existing `users.github.*` connection and `tools.github.*` account Gateway methods, device authorization, and OAuth refresh scheduling. Its managed service starts once per Gateway and drains accepted token rotations when stopped. Record persistence and accepted-publication custody retain their native owners. The same service installs GitHub publication policy/transport and the declared repository source for local and worker callers. The package also owns the prepared execution identity provider; core retains process and sandbox custody.

The package also owns the shallow host, managed-account, and OAuth protocol artifacts used by
native core callers. Those artifacts do not load the plugin runtime.

Configuration stays canonical at `gateway.github`, `tools.github`, and
`agents.entries.<id>.tools.github`. The Settings renderer reads those current
owners through its one local projection; it does not introduce a second writer
or accept a plugin-config fallback. That current-key Settings projection is removed when all GitHub configuration
readers and writers make their final cutover together.

Settings contributions follow the normal admitted plugin catalog. Disabling or
denying this plugin removes its contributed views, account RPCs, and execution
identity provider; new repository-source admission stops, while publication effects require the current managed service. Packaged Memory/channel setup views retain their separate
availability contract, including disabled-plugin setup.

`oauth-api.ts` owns the remote GitHub protocol and verification cache.
The identity/profile artifacts own native CLI credential selection and its cache;
lifecycle callers explicitly invalidate both credential and verification caches
when an identity changes. OAuth record persistence remains host-owned; the managed plugin service owns scheduling.

The identity/profile artifacts own native and managed credential selection, App
installation protocol, profile reads and writes, retired-profile cleanup, and
credential environment formatting. Existing repository and publication callers consume these operations; their
transaction owners remain native. Repository clone/fetch transport is described below. Native OAuth records remain
host-owned through admitted record operations.

The pure `profile-id-api.ts` format also serves native configuration and persisted
record validation. The native host-snapshot adapter remains for the frozen PR
wrapper; the plugin adapter reads the same canonical in-memory snapshot. Neither
adapter owns a second configuration or a legacy fallback. Agent selections remain
at `agents.entries[agentId].tools.github`.

The account service follows normal plugin admission. Disabling or excluding this plugin removes account RPCs and stops new refresh work; it does not erase saved credentials. Gateway storage owners retain record admission and exact refresh settlement.

The execution provider contributes identity facts and private launch adapters for
local commands and supported Docker/Podman sandboxes. Core retains approvals,
container allocation, process supervision, and generic Git defaults. Current
native GitHub configuration keys remain canonical until their atomic cutover.

The shallow project URL and Git clone/fetch artifacts own GitHub remote normalization and network command policy. Their current local and worker callers use the same implementation. The native managed-checkout owner retains project registration, leases, and uncertain-write cleanup. The managed account service now installs the declared source used by New Session, local preparation, worker checkout, and Gateway restoration. The source owns search and URL/account admission; native custody retains state, captured environment, registration, leases, and uncertain-write cleanup. SDK callers cannot select configuration, database paths, or environment. Host-created transport options carry the captured environment one way to the exact Git operation. See [Repository sources](https://docs.openclaw.ai/plugins/sdk-repository-sources).

## Managed publication

The account service installs `publication-provider-api.ts` under its actual plugin
instance, scheduler, and Gateway lifetime. GitHub identity, targets, inspection,
preflight, remote Git/object operations, workflow policy, and formatting belong to
the plugin. Native tool/RPC callers retain requester and session authority; native
engines retain checkpoints, accepted receipts, uncertain-write reconciliation, and
transcript acceptance. Worker credential delivery retains its native turn and
workspace owner, separately from source checkout identity.

Publication content reuses current native credit/sharing facts and the existing
formatters. Withdrawal fences new effects and captured APIs without deleting
accepted native work or redirecting it to another account. Native runtime close
joins whole admitted operations before closing receipt custody. Current root
configuration keys are unchanged. See the
[publication lifecycle](https://docs.openclaw.ai/plugins/github-publication) for
source ownership and recovery boundaries.

## Public GitHub reader

The same plugin owns public previews, document reading, `github_read`, and
`github_search`. Reader methods, scopes, coding-profile defaults, bounded
responses and credential admission are unchanged. Set
`plugins.entries.github-repositories.config.reader.enabled=false` to disable
only these contributions without disabling accounts or native repository work.

Doctor migrates the retired `github` reader policy into that setting. Its normal
configured-plugin repair may enable and allowlist the consolidated integration;
explicit new-plugin disable, deny, and global disable remain effective. Native
identity/service settings keep their current keys in this preparatory change.
See [GitHub reader documentation](https://docs.openclaw.ai/plugins/github).

The public `public-api.ts` artifact owns native HTTP/read composition; it shares
the reader library and error/cooldown identities without activating the plugin.

## Read presentation library

`read-facts-api.ts` provides inert PR ordering, identifiers, badge copy, and activity
pill facts. `browser/read-presentation-api.ts` provides typed mount/update/dispose handles
for PR rows, mobile read regions, hovercards, Activity, and session summaries.
Renderers receive current values and callbacks plus native visual controls; they
do not receive an application context or create a read store.

The existing native connection store still owns the single replace-set subscription,
scope invalidation, and read snapshots. Native publication controls, CI request/write
owners, mobile Root/Back, and English remain canonical. These read views keep their
existing native admission at this stage; disabling the plugin does not remove them.
Settings and account/execution contributions continue to follow plugin admission.

The temporary native read-composition adapter is removed when publication and the
remaining native readers can transfer this same store and its remaining consumers
together. There is no second store, new configuration namespace, or fallback reader.

### Observed Open PR action

The GitHub browser activation registers the session **Open PR** action in sidebar
and Sessions menus, with the native PR icon, `g` shortcut, and new-tab metadata.
The host's `sessionPullRequests.read/observe` port borrows the same native
connection store; displaying a menu adds one scoped interest to its existing
replace-set union. Closing the menu or withdrawing the activation releases it.
The action resolves the current primary PR again at dispatch, not a cached URL.
Native translation and safe external navigation retain their current owners.

Disabling or excluding the GitHub plugin removes this registered action. It does
not remove the independently composed read views or native publication controls.
Publication, CI request/write custody, and mobile Root/Back remain native. The
remaining store transfer is deferred to UI-F, with all native consumers moved
atomically; this action introduces no second browser runtime or configuration.

### Observed text references

The browser activation registers GitHub shorthand through the host's
`registerTextReferenceProvider` contract and existing `link-reader` capability.
Transcript, streaming Markdown, and file detail consumers transform prose only
while this plugin's `github` reader is admitted. Reader withdrawal, exclusion,
replacement, and consumer disposal stop transformation and release observers.

`browser/text-reference-api.ts` exposes the provider and pure immutable snapshots.
The provider borrows the same native `sessionPullRequests.read/observe` port and
projects current aliases through scoped host requests and events. Pending or
failed alias reads do not guess a checkout; connection read-scope changes reject
late results. Code, authored links, ambiguous aliases, and unknown repositories
stay intact. Native Markdown sanitization, publication, CI custody, mobile
Root/Back, and the one existing PR store remain unchanged. See the
[text-reference contract](https://docs.openclaw.ai/plugins/feature-plugins#observed-text-references).
