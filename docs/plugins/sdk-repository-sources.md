---
summary: "Managed repository source admission, local checkout and worker preparation"
title: "Repository sources"
read_when:
  - Adding a repository source to a managed Gateway plugin
  - Reviewing local checkout and worker source authority
---

# Repository sources

Declare `repositorySources` in the plugin manifest, register the declared search
Gateway method, then call `installRepositorySource` from the plugin's managed
service. Import the runtime contract from `openclaw/plugin-sdk/repository-sources`.
Installation requires the current plugin instance, its declared local source ID,
and the existing Gateway service binding. The host qualifies IDs as
`plugin-id/source-id`. Stopping or replacing that service retires its retained
source operations; it never redirects them to another plugin.

## Search and selection

Each manifest row contains `id`, `label`, and `searchMethod`. The local ID uses
lowercase letters, digits, `.`, `_`, or `-`, begins with a letter or digit, and is
at most 128 characters. A plugin may declare at most 16 unique sources.
`plugins.controlUi.list` publishes these facts independently of browser assets.
A source can appear in New Session without loading a plugin browser entrypoint.

The search method returns the existing project-search envelope:
`{ credential, projects, stale? }`. Each project retains `name`, `fullName`,
`cloneUrl`, `webUrl`, and its existing optional description/branch/privacy fields.
The host does not change `projects.searchRemote` into a source-specific response.
The picker maps those facts to its display rows and sends `repositorySource`
only with a surviving `repository` or `projectGitUrl` selection. Disabled sources
keep the draft selection and explain why submission is blocked; local folders
remain usable. A missing source or ambiguous URL fails closed on the Gateway.

## Runtime flow and custody

`src/gateway/server-runtime-state-prepare.ts` creates the per-Gateway source
registry. The GitHub account service installs its source after constructing its
existing OAuth owner. `sessions.create` resolves the exact source before saving
repository intent. Local first-turn preparation consumes that source and retains
its assertion through checkout/worktree binding. Session state records the source
ID, not a token or a second credential representation.

The managed-checkout factory binds configuration from the existing admitted
Gateway resolver at each invocation. SDK callers supply only repository intent
and bounded operation options: cancellation, deadline, credential, and live
assertions/starters. They cannot select configuration, database paths, or process
environment. The native custodian captures state and environment, holds clone and
checkout leases, registers the result, and settles uncertain writes before
cleanup. Its separate transport options pass that captured environment **one way**
to the exact clone/fetch operation. This preserves environment snapshot and
Windows semantics without adding environment fields to caller options, source
metadata, browser payloads, or persisted facts. The source owns remote URL and
Git credential/argument policy; the native owner retains launch/custody.

Worker intent, actual provider preparation, checkout, and Gateway restoration
consume the same source registry. Native preparation still owns agent admission,
recipe selection, reuse keys, and lifecycle cancellation. The source supplies
immutable repository metadata and read identity, then confirms the repository
instance after recipe resolution before reusable capacity is advertised. Later
revalidation checks current account/access independently. Private or Enterprise
sources prepare an authenticated pack through the existing native pack owner.
Its source ID, namespace, visibility, repository and recorded account facts remain
cache partitions, never live authorization. A task-bound one-use checkout
transfer delivers Git authentication directly to its admitted worker tunnel.
Accepted checkpoint/restore and rollback custody remain native.

Source read/checkout identity does not authorize publication or executable worker
credentials. Those retain the current native publication availability and
`worker-github-binding.ts` owners, including turn-grant refresh and revocation.
No additional publication provider or credential delivery owner is installed.

For GitHub, [canonical plugin configuration](/plugins/github-configuration)
selects endpoints, shared and agent identities, and the repository-search native
credential opt-in. Reader-only disable does not disable repository sources;
normal plugin disable/deny removes new source admission without erasing accounts
or accepted checkpoints.
