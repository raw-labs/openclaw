---
summary: "Canonical GitHub plugin settings, account responsibilities, and upgrade migration"
title: "GitHub configuration and migration"
read_when:
  - Configuring shared or per-agent GitHub credentials
  - Upgrading from core GitHub settings or the reader-only plugin
---

The bundled **GitHub** plugin has one runtime ID, `github-repositories`.
Its canonical configuration is `plugins.entries.github-repositories.config`.
The plugin owns repository access, shared and per-agent execution identity,
personal publication, link readers, and their settings presentation. Provider
credentials for GitHub Copilot remain separate.

## Shared sign-in settings

Independent Gateway sign-in remains owned by core, including canonical profile
workers, Cloudflare Access verification, Tailscale provider identities, and
trusted Enterprise principals. It does not activate the repository plugin runtime. Trusted visitor-account
lookup is also identity metadata and remains available when native repositories are disabled; its existing caller and lifetime
checks still apply. Public account metadata has its own bounded transport and
cache; a metadata credential raises quota and never identifies the authenticated human.

An existing shared configuration contract remains explicit: Enterprise sign-in
checks the trusted principal's host against
`plugins.entries.github-repositories.config.host`, and public GitHub metadata
may use the matching `config.service.token`. Core and the plugin consume the existing
lightweight public host and service selectors for these settings. Disabling native GitHub does not
disable sign-in, remove this host binding, or migrate these settings elsewhere.
An explicitly authored string token remains usable for independent metadata.
Disabled-plugin SecretRefs stay dormant and are never resolved by sign-in; when
such a value is unmaterialized, independent public metadata uses the existing
`GH_TOKEN`, `GITHUB_TOKEN`, or anonymous path. Enabled-plugin secret degradation
still fails closed under the existing secret-owner contract.

This retained shared-auth contract is a reason not to describe all GitHub-named
behavior as optional native functionality. The native repository plugin can be
disabled without removing the independent sign-in implementation.

```json5
{
  plugins: {
    entries: {
      "github-repositories": {
        enabled: true,
        config: {
          service: {
            token: { source: "store", provider: "default", id: "TEAM_GITHUB" },
          },
          reader: { enabled: true },
        },
      },
    },
  },
}
```

Omit `host` and `apiBaseUrl` for github.com. Configure both for an Enterprise
host; the HTTPS API endpoint must belong to that host. Hostnames accept existing
case and surrounding-whitespace variants; runtime selection trims and lowercases
them. Lowercase, unpadded literals are recommended. Doctor normalizes migrated
literal hosts and preserves authored environment references unchanged.
`service.host` binds the service credential to its GitHub host and defaults to github.com. An unavailable
or mismatched service credential does not fall back to another credential.
Public GitHub can use the existing process environment fallback when no service
credential is configured.

`repositorySearch.useNativeCredentials` defaults to false. It controls whether
repository discovery uses the existing native `gh` credential path; it does not
disable repository search. With false, discovery uses its service-credential path.

## Account responsibilities

- `system` selects the shared managed execution identity.
- `agents.<agent-id>` replaces that identity for one agent. `allowInSandbox`
  retains the existing explicit sandbox credential permission; migration never
  adds that permission. Map keys use canonical normalized agent IDs, even when
  the roster's authored key has different casing. Doctor preserves that selection
  under the normalized ID and refuses colliding legacy identities.
- `service` authenticates repository discovery and supported API reads. It does
  not establish the signed-in person's identity.
- **My GitHub** is an authenticated person's explicit publication connection,
  stored by the existing account owner rather than in authored configuration.
- Verified sign-in identity and the person's co-author preference remain profile
  state. Connecting a publishing credential does not change that identity.

Identity objects retain their existing `profileId`, credential kind, Git author,
and optional App installation fields. Account setup writes those selections
through the existing serialized configuration mutation owner. Tokens and signing
keys are never returned in account status.

## Upgrade from core settings

OpenClaw already supports plugin-owned Doctor migrations; no runtime compatibility
reader or bridge is needed. Run `openclaw doctor --fix`. Managed updates use the
same candidate Doctor repair path. Deterministic single-file repairs can also use
the existing automatic config-repair admission. Ordinary runtime readers consume
only the canonical plugin shape and do not reinterpret old keys.

| Previous setting                             | Canonical setting under plugin `config` |
| -------------------------------------------- | --------------------------------------- |
| `tools.github`                               | `system`                                |
| `agents.entries.<id>.tools.github`           | `agents.<id>`                           |
| `gateway.github.host`                        | `host`                                  |
| `gateway.github.apiBaseUrl`                  | `apiBaseUrl`                            |
| `gateway.controlUi.github.host`              | `service.host`                          |
| `gateway.controlUi.github.token`             | `service.token`                         |
| `gateway.projects.nativeGitHubSearch`        | `repositorySearch.useNativeCredentials` |
| Reader-only `plugins.entries.github.enabled` | `reader.enabled`                        |

The reader-only `github` package is retired. Its disabled setting becomes
`reader.enabled=false`; it does not unexpectedly disable native repository and
publication behavior that previously lived outside that plugin. The new plugin's
`enabled=false` disables the whole integration. A preexisting new-format value
wins over its legacy counterpart, including explicit false values. Doctor reports
conflicting paths without logging credentials. Endpoint host/API pairs and service
credential/host selections are atomic: Doctor never fills a partial canonical
selection from a conflicting legacy group. Identity selections are also atomic;
it never combines one account's App material with another account's profile ID.

Doctor preserves unrelated configuration, account/secret records, publication
receipts, and the existing include and backup ownership rules. SecretRef objects
move unchanged; Doctor restores authored environment references through its
existing writer. Supported single-owner includes use the existing include-aware
repair. Ambiguous, shared, external or otherwise unsafe include writes retain the
writer's refusal and recovery guidance. No runtime reader bypasses that boundary.

The migration transform is idempotent and leaves `plugins.allow`, `plugins.deny`,
and global plugin enablement unchanged. Doctor then applies its existing
configured-plugin repair: migrated GitHub configuration can enable
`github-repositories` and add that ID to a nonempty allowlist. To keep the whole
integration inactive, explicitly set `plugins.entries.github-repositories.enabled=false`,
add the new ID to `plugins.deny`, or disable plugins globally. Existing
`plugins.enabled=false` now disables native GitHub too; the former core
integration ignored that switch. Retired reader restrictions remain
`reader.enabled=false`, independently of whole-plugin activation. Extra policies or
nonempty config on the retired reader entry require explicit review: Doctor
preserves that input instead of guessing how to combine plugin permissions.
Unrecognized legacy fields also remain visible for manual repair.

The plugin manifest declares `service.token`, `system.app.privateKey`, and
`agents.*.app.privateKey` as SecretRef surfaces. The shared secret owner resolves
them only while the plugin is active. Missing credentials belonging to a disabled
plugin remain dormant; schema validation and migration do not activate GitHub.

A nonempty old allowlist that excluded `github` keeps the reader disabled,
even when no old reader entry exists: lists containing only `github-repositories`
or only another plugin also project `reader.enabled=false`. An explicit old
`github` deny or disabled reader entry does the same. An explicit canonical
`reader.enabled` wins. The transform leaves admission lists unchanged;
subsequent configured-plugin repair follows the policy above.

Deleting an agent removes its entry from the plugin's `agents` map through the
shared agent config mutation, including while GitHub is disabled. Recreating the
same agent id starts without the deleted agent's GitHub selection or sandbox
permission. Shared and personal accounts are unaffected.

## Runtime and write ownership

`extensions/github-repositories/config-api.ts` reads the admitted canonical block.
The plugin's manifest and `config-schema-api.ts` validate its shape; runtime
readers do not inspect retired root settings. `doctor-contract-api.ts` projects
legacy input into a private candidate before the existing Doctor writer handles
includes, validation and backups. A malformed targeted canonical container keeps
the original input intact and produces a path-only warning.

Account setup calls `tool-identity-config-api.ts`, which compares the selected
identity and uses `src/config/plugin-config-mutation.ts` for the write. Agent
deletion calls `plugin-agent-config.ts` through the existing roster mutation.
Secret materialization and names-only child exclusions use the shared secret
owner and declared manifest paths. Plain security audit loads only the declared
`security-audit-api.js` artifact, not the plugin runtime. These configuration
operations do not own session authority, worker launches or publication receipts.
