---
summary: "Prepared plugin execution overlays, local launch adapters, and sandbox projections"
title: "Execution environments"
read_when:
  - Adding a plugin-owned process identity or sandbox credential projection
  - Reviewing command approval and plugin lifecycle boundaries
---

# Execution environments

`api.registerExecutionEnvironment(provider)` registers a version-1 contribution
in the existing plugin registry. Types come from
`openclaw/plugin-sdk/execution-environment`. It adds no user configuration option.
The selected runtime owns activation; disabled plugins register no contribution.

`prepare({ config, sourceConfig, agentId, assertCurrent, signal })` returns
`PreparedExecutionEnvironment`: `credentialScrubEnv`, `localIdentityEnv`,
`excludedStoreNames`, `managedLocalIdentity`, and optional
`localGitConfigParameters`, `hostExecutionRequired`, and `wrapLocalLaunch`.
These are nonsecret facts. Never return a bearer token in an environment overlay.

The host captures the admitted registry once during turn preparation, or at the
first actual standalone exec. It never loads plugins at module initialization or
looks up a global replacement registry for a retained run. Harnesses pass their
prepared runtime registry explicitly. A standalone exec with no admitted registry
has no integration contribution. If no prepared exclusion facts exist, the
existing secret owner records declared env/store exclusion names once from the
run configuration and manifest metadata, without resolving credentials or running
a disabled plugin. A standalone exec without a prepared secrets runtime projects
no team secret-store overlay; the explicit host-prepared
`preparedStoreEnvironment` contract remains available. Normal CLI agent startup
prepares that secrets runtime before running tools.

`wrapLocalLaunch(argv)` receives the exact final shell argv after command planning
and approval. It may enclose that command in a private child credential bootstrap.
It must preserve the reviewed command, keep secrets out of argv and supervised
environment data, and revalidate its current held authority. Core retains the
final source/approval checks and actual process supervision. The plugin instance
owns the callback lifetime; retained adapters cannot admit new work after retirement.
Remote nodes receive neither local identity overlays nor this callback.

`prepareSandbox(input)` additionally receives the existing backend and scope.
It returns the same top-level prepared fields plus `readOnlyResourceMounts` and
`inheritedEnvironmentNames`. The plugin decides account opt-in and supported
scope/backend policy. Core validates and installs read-only mounts under existing
sandbox custody. Private inherited values pass to the container engine by name;
they are never written into its environment file. Both factory return shapes
expose only `wrapLocalLaunch` as an executable result, leaving ordinary facts
copyable. Conflicting identity values or mount targets name the competing owners
and fail; equivalent mount declarations collapse to one.

The existing `resolve_exec_env` hook remains a separate ordinary, sanitized
per-command environment hook. This registration does not expand its authority.
Core still owns PATH, installation routing, shell snapshots, approvals, and process
cleanup. Ordinary agent Git maintenance defaults stay in core independently from
repository plugins. The core local CLI environment owner preserves independent
GitHub CLI ambient authentication even with native repositories disabled; exact
prepared credential scrubs apply afterward. Gateway authentication is not forwarded
to nodes or sandboxes by that exception.

Credential input paths may declare `executionEnvironment: "exclude"` in manifest
secret-input metadata. The existing secret preparation owner records exact env/store
reference exclusions, including inactive plugin paths, without resolving dormant
credentials. Execution consumes those prepared facts.
They do not load disabled plugin code or walk configuration again at each command.
Until the later atomic configuration cutover, the existing core secret owner
records exclusions for canonical `tools.github`, agent overrides, and
`gateway.controlUi.github` credentials as well.
Other secret inputs retain their existing projection policy.

The `github-repositories` plugin owns native account selection, sandbox opt-in,
Git author overlays, and its host child launcher. The current remote worker
GitHub binding/heartbeat wire remains unchanged. Its shared
`worker-github-credentials` SDK leaf owns only the current profile projection, private
file custody, and child decoding; plugin writers retain account notifications.
That explicit native worker format is a remaining core dependency, not a second
plugin implementation or a runtime compatibility reader.
