---
summary: "Experimental registration contract for plugin execution preparation"
title: "Execution environment registration"
read_when:
  - Reviewing plugin-owned process identity preparation
  - Registering a future execution environment adapter
---

# Execution environment registration

`api.registerExecutionEnvironment(provider)` records an optional execution
preparer in the admitted plugin registry. Import its versioned types from
`openclaw/plugin-sdk/execution-environment`.

This experimental prerequisite adds registration and lifetime handling only.
No bundled plugin registers a provider, and existing command, harness and sandbox
paths do not invoke these contributions yet. Native GitHub execution and account
selection remain unchanged. This is not a usable automatic credential-injection
feature until a later host integration and real consumer are reviewed together.

`prepare({ config, sourceConfig, agentId, assertCurrent, signal })` returns
nonsecret environment facts, excluded store names, optional Git parameters and an
optional `wrapLocalLaunch(argv)` callback. `prepareSandbox` may additionally
return read-only mount descriptions and inherited environment names. Returned
facts must not contain bearer credentials.

Registration requires a managed plugin instance and a valid plugin-local id.
Duplicate ids within an owner are rejected. The existing plugin-instance owner
binds the preparers and their returned launch callbacks; retained callbacks stop
being callable when that instance is retired. These contracts do not grant
process execution, bypass command approval, or create sandbox permission.

Manifest SecretRef paths may separately declare
`executionEnvironment: "exclude"`. Secret preparation records the referenced
environment/store names even while their plugin is disabled, without resolving
those credentials. Recording an exclusion does not itself filter a child
process. A future execution integration must consume those facts at its existing
environment owner.
