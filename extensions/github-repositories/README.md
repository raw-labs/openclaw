# GitHub Settings and repository artifacts

This plugin owns Profile → GitHub connections and the GitHub identity view in
Agent → Tools. The plugin owns the existing `users.github.*` connection and `tools.github.*` account Gateway methods, device authorization, and OAuth refresh scheduling. Its managed service starts once per Gateway and drains accepted token rotations when stopped. Record persistence and accepted-publication custody retain their native owners. The same service installs GitHub publication policy/transport and the declared repository source for local and worker callers. The package also owns the prepared execution identity provider; core retains process and sandbox custody.

The package also owns the shallow host, managed-account, and OAuth protocol artifacts used by
native core callers. Those artifacts do not load the plugin runtime.

Configuration is canonical at `plugins.entries.github-repositories.config`.
Settings reads that admitted block and writes through the bounded include-aware
configuration owner. Doctor alone recognizes retired root keys. See
[GitHub configuration](https://docs.openclaw.ai/plugins/github-configuration).

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

The pure `profile-id-api.ts` format also serves plugin configuration and persisted
record validation. The native host-snapshot adapter remains for the frozen PR
wrapper; the plugin adapter reads the same canonical in-memory snapshot. Neither
adapter owns a second configuration or a legacy fallback. Agent selections remain
at `plugins.entries.github-repositories.config.agents[agentId]`.

The account service follows normal plugin admission. Disabling or excluding this plugin removes account RPCs and stops new refresh work; it does not erase saved credentials. Gateway storage owners retain record admission and exact refresh settlement.

The execution provider contributes identity facts and private launch adapters for
local commands and supported Docker/Podman sandboxes. Core retains approvals,
container allocation, process supervision, and generic Git defaults. The canonical plugin block owns shared and per-agent selections.

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
joins whole admitted operations before closing receipt custody. Publication uses the canonical plugin configuration. See the
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
explicit new-plugin disable, deny, and global disable remain effective. All account, endpoint and service settings use the canonical plugin block.
See [GitHub reader documentation](https://docs.openclaw.ai/plugins/github).

The public `public-api.ts` artifact owns native HTTP/read composition; it shares
the reader library and error/cooldown identities without activating the plugin.

## Repository browser contributions

The GitHub browser activation owns one PR snapshot store and watched-key union.
Session details, sidebar badges, hovercards, Activity, summaries, Open PR, and
text references all use that store. Foreground demand has priority over passive
row receipts within the existing cap. Closing a view releases its interest;
connection, permission, and structural-session changes retire scoped facts.
`read-facts-api.ts` remains the inert owner of ordering, identifiers, and badge
and activity facts. Native composition no longer imports plugin renderers.

Publication presentation and CI controls belong to the same activation. The
Gateway remains authoritative for publication receipts and Cron jobs. Native
session custody retains admitted publication operations across detached views,
including unknown outcomes, the original retry key/account, and confirmation.
Disabling the plugin removes its browser contributions and prevents new UI
actions; it does not replay, cancel, or forget an already admitted write.

The generic host supplies these boundaries:

- `host.requests.capture()` returns request/currentness operations bound to the
  current connection and activation, never the authenticated client or handshake.
  It accepts cancellation and timeout options. `createSetSync()` delegates the
  existing native batching, retry, acknowledgement, and visibility lifecycle.
- `host.sessions.methodAccess()` retains native session-operation admission.
  `attachOperation()` retains one plugin/factory/session operation in the native
  bounded custody owner; disposing a presentation detaches its binding without
  cancelling an accepted operation. `captureSummary()` captures the roster
  writer's epoch before a read, so a retired result cannot acquire a newer epoch
  when it publishes.
- `host.presentation` provides shared visual controls, localized copy, formatting,
  safe URLs, and deterministic declaration digests. `host.native` contains only
  the existing diff and disclosure-overlay DOM operations. Plugin CI controls
  render their own Solid components and stable host tags.

Accessories can target session header, context, row, hovercard, Activity,
summary, and mobile root/page/activity slots. Mobile pages use opaque plugin IDs;
the native host still owns Root/Back ancestry, keyboard traversal, focus,
geometry, close return, and pane retirement. A plugin receives navigation
callbacks, not ownership of that host.

### Observed Open PR action

The activation registers **Open PR** in sidebar and Sessions menus with the PR
icon, `g` shortcut, and new-tab metadata. Displaying a menu adds scoped interest
to the same plugin store; closing it releases that interest. Dispatch resolves
the current primary PR again, not a saved URL. Native safe external navigation
opens it without an opener. Disabling or excluding the plugin removes the action
and its other repository browser contributions.

### Observed text references

The browser activation registers GitHub shorthand through the host's
`registerTextReferenceProvider` contract and existing `link-reader` capability.
Transcript, streaming Markdown, and file detail consumers transform prose only
while this plugin's `github` reader is admitted. Reader withdrawal, exclusion,
replacement, and consumer disposal stop transformation and release observers.

`browser/text-reference-api.ts` exposes the provider and pure immutable snapshots.
The provider reads the same plugin-owned PR store and
projects current aliases through scoped host requests and events. Pending or
failed alias reads do not guess a checkout; connection read-scope changes reject
late results. Code, authored links, ambiguous aliases, and unknown repositories
stay intact. Native Markdown sanitization and mobile Root/Back remain host-owned;
publication presentation and CI controls share the plugin activation. See the
[text-reference contract](https://docs.openclaw.ai/plugins/feature-plugins#observed-text-references).
