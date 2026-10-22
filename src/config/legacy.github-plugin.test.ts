import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import repositoryPlugin from "../../extensions/github-repositories/index.js";
import repositoryManifest from "../../extensions/github-repositories/openclaw.plugin.json" with { type: "json" };
import {
  prepareGitHubToolEnvironment,
  resolveManagedGitHubProfileDir,
} from "../../extensions/github-repositories/tool-identity-api.js";
import { cleanupRetiredManagedGitHubProfiles } from "../../extensions/github-repositories/tool-profile-cleanup-api.js";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { normalizePluginsConfigWithResolverCore } from "../plugins/config-normalization-shared.js";
import { resolveEffectivePluginActivationState } from "../plugins/config-state.js";
import { collectDoctorConfigRepairPluginIds } from "../plugins/doctor-contract-registry.js";
import { validatePluginConfig } from "../plugins/loader-shared.js";
import { createPluginManifestIdNormalizer } from "../plugins/plugin-manifest-id-normalizer.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createConfigIO } from "./config.js";
import { resolveConfigEnvVars } from "./env-substitution.js";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import type { OpenClawConfig } from "./types.openclaw.js";

it.each(["Build", " build ", "build!", "b".repeat(65)])(
  "rejects noncanonical GitHub agent map keys during manifest admission: %s",
  (agentId) => {
    expect(
      validatePluginConfig({
        origin: "bundled",
        schema: repositoryManifest.configSchema,
        value: { agents: { [agentId]: { profileId: "ghp_44444444444444444444444444444444" } } },
      }).ok,
    ).toBe(false);
  },
);

it("keeps a mixed-case roster's selected GitHub generation through Doctor, reload and startup cleanup", async () => {
  await withTempHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const env = { HOME: home, OPENCLAW_STATE_DIR: stateDir };
    const identity = {
      profileId: "ghp_44444444444444444444444444444444",
      allowInSandbox: true,
      gitAuthor: { name: "Build Author", email: "build@example.test" },
    };
    const source = {
      agents: { entries: { Build: { tools: { github: identity } } } },
      tools: { github: { profileId: "ghp_55555555555555555555555555555555" } },
    };
    const raw = JSON.stringify(source);
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: "build",
      scope: "agent",
      profileId: identity.profileId,
      env,
    });
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    const profilePath = path.join(profileDir, "hosts.yml");
    const profileBytes = "github.com:\n  oauth_token: synthetic-selected-agent-token\n";
    await fs.writeFile(profilePath, profileBytes, { mode: 0o600 });
    await fs.writeFile(configPath, raw);
    const io = createConfigIO({
      configPath,
      env,
      homedir: () => home,
      observe: false,
      pluginValidation: "core-only",
    });
    try {
      const migrated = migrateLegacyConfig(source, { sourceConfigBeforeMigrations: source });
      expect(migrated.partiallyValid).not.toBe(true);
      if (!migrated.config) {
        throw new Error("Doctor did not migrate GitHub configuration");
      }
      await io.writeConfigFile(migrated.config, {
        skipPluginValidation: true,
        persistCanonicalAgentRoster: true,
      });
      const reloaded = await io.readConfigFileSnapshot();
      expect(reloaded.valid).toBe(true);
      // Startup cleanup must recognize the same selected generation as the normalized session id.
      expect(await cleanupRetiredManagedGitHubProfiles({ config: reloaded.config, env })).toEqual({
        warnings: [],
      });
      expect(await fs.readFile(profilePath, "utf8")).toBe(profileBytes);
      expect(reloaded.config.plugins?.entries?.["github-repositories"]?.config?.agents).toEqual({
        build: identity,
      });
      expect(
        prepareGitHubToolEnvironment({ config: reloaded.config, agentId: "build", env }),
      ).toMatchObject({
        managedLocalIdentity: true,
        localIdentityEnv: {
          GH_CONFIG_DIR: profileDir,
          GIT_AUTHOR_NAME: "Build Author",
          GIT_AUTHOR_EMAIL: "build@example.test",
        },
      });
      expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(raw);
      expect(
        migrateLegacyConfig(reloaded.config, {
          sourceConfigBeforeMigrations: reloaded.config,
        }).changes,
      ).toEqual([]);
    } finally {
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
    }
  });
});

it("discovers the disabled GitHub owner and persists its canonical migration with original backup bytes", async () => {
  await withTempHome(async (home) => {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const source = {
      plugins: { entries: { "github-repositories": { enabled: false } } },
      agents: {
        entries: {
          main: {
            tools: {
              github: { profileId: "ghp_11111111111111111111111111111111", allowInSandbox: false },
            },
          },
        },
      },
      tools: { github: { profileId: "ghp_22222222222222222222222222222222" } },
      gateway: {
        github: { host: "  GHE.EXAMPLE.TEST  ", apiBaseUrl: "https://ghe.example.test/api/v3" },
        controlUi: { github: { host: "  GHE.EXAMPLE.TEST  ", token: "synthetic-service-token" } },
      },
    };
    const raw = JSON.stringify(source);
    await fs.writeFile(configPath, raw);
    const env = { HOME: home, OPENCLAW_STATE_DIR: path.dirname(configPath) };
    const io = createConfigIO({
      configPath,
      env,
      homedir: () => home,
      observe: false,
      pluginValidation: "core-only",
    });
    try {
      expect(collectDoctorConfigRepairPluginIds(source)).toContain("github-repositories");
      const migrated = migrateLegacyConfig(source, {
        sourceConfigBeforeMigrations: source,
        context: { authoredRaw: source, resolvedRaw: source, env, homedir: () => home },
      });
      expect(migrated.partiallyValid).not.toBe(true);
      expect(migrated.config).not.toBeNull();
      if (!migrated.config) {
        throw new Error("Doctor did not migrate GitHub configuration");
      }
      expect(migrated.config.plugins?.entries?.["github-repositories"]).toMatchObject({
        enabled: false,
        config: {
          system: { profileId: "ghp_22222222222222222222222222222222" },
          host: "ghe.example.test",
          apiBaseUrl: "https://ghe.example.test/api/v3",
          service: { host: "ghe.example.test", token: "synthetic-service-token" },
          agents: {
            main: { profileId: "ghp_11111111111111111111111111111111", allowInSandbox: false },
          },
        },
      });
      const manifest = loadPluginManifestRegistryForPluginRegistry({
        config: migrated.config,
        includeDisabled: true,
      }).plugins.find((plugin) => plugin.id === "github-repositories");
      if (!manifest) {
        throw new Error("GitHub manifest was not discovered");
      }
      expect(
        validatePluginConfig({
          origin: manifest.origin,
          schema: manifest.configSchema,
          value: migrated.config.plugins?.entries?.[manifest.id]?.config,
        }).ok,
      ).toBe(true);
      const expanded = resolveConfigEnvVars(
        {
          host: "${LEGACY_GITHUB_HOST}",
          apiBaseUrl: "https://ghe.example.test/api/v3",
          service: { host: "${LEGACY_GITHUB_HOST}", token: "synthetic-service-token" },
        },
        { LEGACY_GITHUB_HOST: "  GHE.EXAMPLE.TEST  " },
      );
      const admitted = validatePluginConfig({
        origin: manifest.origin,
        schema: manifest.configSchema,
        value: expanded,
      });
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) {
        throw new Error(admitted.error.join("; "));
      }
      const registration = createPluginRegistryFixture({
        plugins: { entries: { "github-repositories": { config: admitted.value } } },
      });
      registerTestPlugin({
        ...registration,
        record: createPluginRecord({
          id: manifest.id,
          name: manifest.name,
          contracts: manifest.contracts,
          dashboard: manifest.dashboard,
          repositorySources: manifest.repositorySources,
        }),
        register: repositoryPlugin.register,
      });
      expect(
        registration.registry.registry.gatewayMethodDescriptors.some(
          (method) => method.name === "projects.searchRemote",
        ),
      ).toBe(true);
      expect(registration.registry.registry.controlUiDescriptors.length).toBeGreaterThan(0);
      await io.writeConfigFile(migrated.config, {
        skipPluginValidation: true,
        persistCanonicalAgentRoster: true,
      });
      const after = await io.readConfigFileSnapshot();
      expect(after.valid).toBe(true);
      expect(after.sourceConfig).not.toHaveProperty("tools.github");
      expect(after.sourceConfig).not.toHaveProperty("agents.entries.main.tools.github");
      expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(raw);
    } finally {
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
    }
  });
});

it("preserves include-owned legacy agent input when the existing writer refuses a cross-boundary migration", async () => {
  await withTempHome(async (home) => {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const agentPath = path.join(path.dirname(configPath), "main.json5");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const rootRaw = JSON.stringify({
      plugins: { entries: { "github-repositories": { enabled: false } } },
      agents: { entries: { main: { $include: "./main.json5" } } },
    });
    const agentRaw = JSON.stringify({
      tools: { github: { profileId: "ghp_33333333333333333333333333333333" } },
    });
    await fs.writeFile(configPath, rootRaw);
    await fs.writeFile(agentPath, agentRaw);
    const env = { HOME: home, OPENCLAW_STATE_DIR: path.dirname(configPath) };
    const io = createConfigIO({
      configPath,
      env,
      homedir: () => home,
      observe: false,
      pluginValidation: "core-only",
    });
    try {
      const before = await io.readConfigFileSnapshot();
      const source = before.sourceConfigBeforeMigrations;
      const migrated = migrateLegacyConfig(source, {
        sourceConfigBeforeMigrations: source,
        context: { authoredRaw: before.parsed, resolvedRaw: source, env, homedir: () => home },
      });
      expect(migrated.config).not.toBeNull();
      if (!migrated.config) {
        throw new Error("Doctor did not migrate the resolved GitHub configuration");
      }
      expect(migrated.config.plugins?.entries?.["github-repositories"]?.config).toHaveProperty(
        "agents.main.profileId",
        "ghp_33333333333333333333333333333333",
      );
      await expect(
        io.writeConfigFile(migrated.config, {
          skipPluginValidation: true,
          persistCanonicalAgentRoster: true,
        }),
      ).rejects.toThrow(/include/iu);
      expect(await fs.readFile(configPath, "utf8")).toBe(rootRaw);
      expect(await fs.readFile(agentPath, "utf8")).toBe(agentRaw);
    } finally {
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
    }
  });
});

const readerPolicyCases: {
  policy: NonNullable<OpenClawConfig["plugins"]>;
  expectedWholeEnabled: boolean;
  expectedReaderEnabled: boolean;
  expectedAfterRepair: boolean;
}[] = [
  // No old entry or root settings: old admission alone excluded the standalone reader.
  {
    policy: { allow: ["github-repositories"] },
    expectedWholeEnabled: true,
    expectedReaderEnabled: false,
    expectedAfterRepair: true,
  },
  {
    policy: { allow: ["telegram"] },
    expectedWholeEnabled: false,
    expectedReaderEnabled: false,
    expectedAfterRepair: true,
  },
  {
    policy: { allow: ["github"] },
    expectedWholeEnabled: false,
    expectedReaderEnabled: true,
    expectedAfterRepair: true,
  },
  {
    policy: { deny: ["github"] },
    expectedWholeEnabled: true,
    expectedReaderEnabled: false,
    expectedAfterRepair: true,
  },
  {
    policy: { entries: { github: { enabled: false } } },
    expectedWholeEnabled: true,
    expectedReaderEnabled: false,
    expectedAfterRepair: true,
  },
  {
    policy: { allow: ["github"], entries: { "github-repositories": { enabled: false } } },
    expectedWholeEnabled: false,
    expectedReaderEnabled: true,
    expectedAfterRepair: false,
  },
  {
    policy: { allow: ["github"], deny: ["github-repositories"] },
    expectedWholeEnabled: false,
    expectedReaderEnabled: true,
    expectedAfterRepair: false,
  },
  {
    policy: { enabled: false, allow: ["github"] },
    expectedWholeEnabled: false,
    expectedReaderEnabled: true,
    expectedAfterRepair: false,
  },
];

it.each(readerPolicyCases)(
  "keeps retired reader policy separate from runtime admission and discovers its Doctor owner: %j",
  async ({ policy, expectedWholeEnabled, expectedReaderEnabled, expectedAfterRepair }) => {
    await withTempHome(async () => {
      const raw = { plugins: policy };
      const registry = loadPluginManifestRegistryForPluginRegistry({
        config: raw,
        includeDisabled: true,
      });
      const plugin = registry.plugins.find((record) => record.id === "github-repositories");
      expect(plugin).toBeDefined();
      if (!plugin) {
        throw new Error("GitHub manifest was not discovered");
      }
      const normalizeId = createPluginManifestIdNormalizer(registry);
      const normalized = normalizePluginsConfigWithResolverCore(raw.plugins, normalizeId);
      expect(normalizeId("github")).toBe("github");
      expect(normalized.allow).toEqual("allow" in policy ? policy.allow : []);
      expect(normalized.deny).toEqual("deny" in policy ? policy.deny : []);
      const authoredEntry =
        "entries" in policy ? policy.entries?.["github-repositories"] : undefined;
      if (authoredEntry) {
        expect(normalized.entries["github-repositories"]).toMatchObject(authoredEntry);
      } else {
        expect(normalized.entries["github-repositories"]).toBeUndefined();
      }
      expect(
        resolveEffectivePluginActivationState({
          id: plugin.id,
          origin: plugin.origin,
          config: normalized,
          rootConfig: raw,
          enabledByDefault: plugin.enabledByDefault,
        }).enabled,
      ).toBe(expectedWholeEnabled);
      expect(collectDoctorConfigRepairPluginIds(raw)).toContain("github-repositories");
      const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
      expect(migrated.config).not.toBeNull();
      expect(migrated.config?.plugins?.entries?.["github-repositories"]).toEqual({
        ...authoredEntry,
        config: { reader: { enabled: expectedReaderEnabled } },
      });
      expect(migrated.config?.plugins?.allow).toEqual("allow" in policy ? policy.allow : undefined);
      expect(migrated.config?.plugins?.deny).toEqual("deny" in policy ? policy.deny : undefined);
      if (!migrated.config) {
        throw new Error("Doctor did not migrate the retired reader policy");
      }
      // Doctor's next repair uses the real configured-plugin owner, not the transform alone.
      const repaired = applyPluginAutoEnable({
        config: migrated.config,
        env: {},
        manifestRegistry: registry,
      });
      expect(
        resolveEffectivePluginActivationState({
          id: plugin.id,
          origin: plugin.origin,
          config: normalizePluginsConfigWithResolverCore(repaired.config.plugins, normalizeId),
          rootConfig: repaired.config,
          enabledByDefault: plugin.enabledByDefault,
        }).enabled,
      ).toBe(expectedAfterRepair);
      expect(repaired.config.plugins?.entries?.[plugin.id]?.config).toMatchObject({
        reader: { enabled: expectedReaderEnabled },
      });
      if ("allow" in policy) {
        expect(repaired.config.plugins?.allow?.includes(plugin.id)).toBe(expectedAfterRepair);
      }
    });
  },
);

it.each([
  {
    path: "plugins.entries.github-repositories.config.service",
    config: { service: "opaque" },
    legacy: {
      gateway: { controlUi: { github: { host: "ghe.example.test", token: "synthetic-legacy" } } },
    },
  },
  {
    path: "plugins.entries.github-repositories.config.agents",
    config: { agents: "opaque" },
    legacy: {
      agents: {
        entries: {
          main: { tools: { github: { profileId: "ghp_11111111111111111111111111111111" } } },
        },
      },
    },
  },
  {
    path: "plugins.entries.github-repositories.config.repositorySearch",
    config: { repositorySearch: "opaque" },
    legacy: { gateway: { projects: { nativeGitHubSearch: true } } },
  },
  {
    path: "plugins.entries.github-repositories",
    entry: "opaque",
    legacy: { tools: { github: { profileId: "ghp_11111111111111111111111111111111" } } },
  },
])(
  "preserves malformed canonical container $path through the actual Doctor pipeline",
  async (scenario) => {
    await withTempHome(async () => {
      // Doctor must not discard authored canonical data to make room for a legacy selection.
      const source = {
        ...scenario.legacy,
        plugins: {
          entries: {
            "github-repositories":
              "entry" in scenario ? scenario.entry : { config: scenario.config },
          },
        },
      };
      const before = structuredClone(source);
      const migrated = migrateLegacyConfig(source, { sourceConfigBeforeMigrations: source });
      expect(source).toEqual(before);
      expect(migrated.changes).toEqual([]);
      expect(migrated.warnings?.join(" ")).toContain(scenario.path);
      expect(migrated.warnings?.join(" ")).not.toContain("synthetic-legacy");
      if (migrated.config) {
        expect(migrated.config).toEqual(before);
      }
    });
  },
);
