---
summary: "Plugin repository discovery, checkout, and cloud workspace preparation"
title: "Repository sources"
read_when:
  - Adding a repository host integration through a plugin
  - Preparing plugin repository sources for local or cloud sessions
---

# Repository sources

A repository plugin contributes discovery metadata and registers a source through
`api.registerRepositorySource(source)`. Import `RepositorySourceV1` and its
preparation types from `openclaw/plugin-sdk/repository-sources`.

The manifest declares the local contribution ID and an advertised Gateway search
method:

```json
{
  "repositorySources": [
    {
      "id": "repositories",
      "label": "Example Forge",
      "searchMethod": "example.repositories.search"
    }
  ]
}
```

Register that method using `api.registerGatewayMethod`. Its result follows the
existing remote-project search shape: `projects` contains repository names,
clone/web URLs, visibility, and optional description/default branch; `credential`
describes availability without returning a credential. Discovery is backend
metadata and does not require a plugin browser module or custom UI enablement.

## Selection and local preparation

The picker shows search groups declared by enabled repository plugins.
Selecting a result carries the qualified `pluginId/contributionId` as the optional
`sessions.create.repositorySource`, alongside `projectGitUrl` or `repository`.
An explicit source that is disabled, withdrawn, or does not accept the URL fails
with an actionable error; it never falls back to another account or source.
Without that field, exactly one enabled source must accept the URL. Ambiguous
URLs require explicit selection. The selected qualified source is recorded for
subsequent preparation and recovery; a retry never chooses a replacement source.

The registered source supplies:

- `resolve(url)`: admit and normalize a supported remote URL.
- `prepare({ url, agentId, requiredCommit, signal, assertCurrent })`: prepare a
  project and return its project identity/root, an `assertCurrent` callback, and
  `refresh()` for a later ref lookup.

Use `createManagedProjectCheckoutV1(transport)` when the source needs managed
clones. Its `materialize()` and `refresh()` operations reuse the existing checkout
leases, storage layout, and project registry. The transport supplies URL
resolution and authenticated clone, commit-fetch, and refresh operations; it does
not choose host storage or maintain another registry. Call these operations from
the source's managed plugin invocation so the host can bind current Gateway
configuration and plugin authority.

The session and worktree owners retain preparation, source binding, cancellation,
and commit custody. Providers must call the supplied assertion immediately before
external effects and honor cancellation. Registration binds callbacks and returned
operations to the managed plugin lifetime; a retained reference cannot revive a
retired source.

## Cloud preparation and recovery

Cloud support is optional. A source with a `worker` adapter supplies immutable
repository/object identities, an opaque nonsecret `identityKey`, tree/blob reads,
access revalidation, optional authenticated Git-pack preparation, and checkout. These
operations feed the existing recipe, provisioning, and workspace owners. A source
without that adapter reports that cloud preparation is unavailable.

`identityKey` partitions prepared content; it does not authorize access. Returned
facts contain no account records or bearer credentials. Providers revalidate
current access and repository identity at the supplied boundaries. The host
retains the selected source and pinned commit through dispatch, restart, and
Gateway recovery.

`worker.isIdentityCurrent`, when supplied, performs a cheap selection check
before reusing prepared capacity. It does not replace live access revalidation.
`private` distinguishes private content in the preparation cache partition.
`prepareGitPack` is optional: sources using the existing anonymous archive
transport can omit it; private or Enterprise GitHub sources provide a pack.

Sources participating in host-owned publication recovery can implement
`worker.restore({ url, agentId, requiredCommit, signal, assertCurrent })`. It
returns a managed project, `assertCurrent`, and `readRemoteHead(branch)`. The
source retains credential selection for both checkout and branch observations;
the host retains accepted checkpoint and publication receipts. Sources without
this capability use ordinary checkpoint restoration, even when another source
accepts the same host or URL. Returned callbacks retire with the source and Gateway.

Cold checkout uses a host-owned one-use `RepositoryCheckoutTransfer`. Pass it to
`performRepositoryCheckout` with transport authorization when needed. The transfer
selects the operation and destination; a plugin does not receive the workspace
transport or gain authority to redirect it. Credentials supplied to that effect
are neither returned as source metadata nor persisted in prepared snapshots.

## Compatibility

Existing non-repository plugins need no new registration or manifest fields.
The bundled GitHub integration uses these contracts for repository selection,
checkout, worker preparation, and recovery. Its account/configuration migration
is described in [GitHub configuration](/plugins/github-configuration).
