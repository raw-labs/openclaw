# GitHub Settings and repository artifacts

This plugin owns Profile → GitHub connections and the GitHub identity view in
Agent → Tools. The plugin owns the existing `users.github.*` connection and `tools.github.*` account Gateway methods, device authorization, and OAuth refresh scheduling. Its managed service starts once per Gateway and drains accepted token rotations when stopped. Record persistence, repository sources, and publication retain their native owners. The package also owns the prepared execution identity provider; core retains process and sandbox custody.

The package also owns the shallow host, managed-account, and OAuth protocol artifacts used by
native core callers. Those artifacts do not load the plugin runtime.

Configuration stays canonical at `gateway.github`, `tools.github`, and
`agents.entries.<id>.tools.github`. The Settings renderer reads those current
owners through its one local projection; it does not introduce a second writer
or accept a plugin-config fallback. That current-key Settings projection is removed when all GitHub configuration
readers and writers make their final cutover together.

Settings contributions follow the normal admitted plugin catalog. Disabling or
denying this plugin removes its contributed views, account RPCs, and execution
identity provider; native repository and publication methods remain at this stage. Packaged Memory/channel setup views retain their separate
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

The shallow project URL and Git clone/fetch artifacts own GitHub remote normalization and network command policy. Their current local and worker callers use the same implementation. The native managed-checkout owner retains project registration, leases, and uncertain-write cleanup. This library extraction does not change plugin admission or repository-picker behavior.

GitHub publication body, credit layout and transcript text are shallow library
artifacts. Core prepares contributor and current-sharing facts through the
accepted session owner and still accepts, stores and deduplicates transcript
reports. These formatters do not register a publication provider or change its
activation, credentials, configuration, transaction or recovery ownership.

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
