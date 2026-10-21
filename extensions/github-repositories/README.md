# GitHub Settings and repository artifacts

This plugin owns Profile → GitHub connections and the GitHub identity view in
Agent → Tools. The Settings views use the existing native `users.github.*` and
`tools.github.*` Gateway methods; OAuth scheduling, record persistence, execution, and publication retain their
native owners; identity/profile selection is implemented by the package artifacts.

The package also owns the shallow host, managed-account, and OAuth protocol artifacts used by
native core callers. Those artifacts do not load the plugin runtime.

Configuration stays canonical at `gateway.github`, `tools.github`, and
`agents.entries.<id>.tools.github`. The Settings renderer reads those current
owners through its one local projection; it does not introduce a second writer
or accept a plugin-config fallback. The reader is removed when all GitHub
configuration readers and writers make their final cutover together.

Settings contributions follow the normal admitted plugin catalog. Disabling or
denying this plugin removes its contributed views; it does not disable the still
native GitHub backend. Packaged Memory/channel setup views retain their separate
availability contract, including disabled-plugin setup.

`oauth-api.ts` owns the remote GitHub protocol and verification cache.
The identity/profile artifacts own native CLI credential selection and its cache;
lifecycle callers explicitly invalidate both credential and verification caches
when an identity changes. OAuth record persistence and scheduling remain host-owned.

The identity/profile artifacts own native and managed credential selection, App
installation protocol, profile reads and writes, retired-profile cleanup, and
credential environment formatting. Existing host execution, repository, and
publication callers consume these operations; their transport and transaction
owners have not moved. Native OAuth records remain host-owned through the narrow
read-only SDK contract.

The pure `profile-id-api.ts` format also serves native configuration and persisted
record validation. The native host-snapshot adapter remains for the frozen PR
wrapper; the plugin adapter reads the same canonical in-memory snapshot. Neither
adapter owns a second configuration or a legacy fallback. Agent selections remain
at `agents.entries[agentId].tools.github`.
