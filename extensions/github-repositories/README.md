# GitHub Settings and repository artifacts

This plugin owns Profile → GitHub connections and the GitHub identity view in
Agent → Tools. The Settings views use the existing native `users.github.*` and
`tools.github.*` Gateway methods; OAuth scheduling, credential persistence/selection, execution, and
publication still retain their native owners.

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

`oauth-api.ts` owns remote device/refresh requests and bounded credential verification.
Native CLI token caching remains host-owned; existing lifecycle callers explicitly
invalidate both owners when an identity changes.
