import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../agents/tool-policy.js";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
import { normalizePluginsConfigWithResolverCore } from "../plugins/config-normalization-shared.js";
import { resolveEffectivePluginActivationState } from "../plugins/config-state.js";
import { collectDoctorConfigRepairPluginIds } from "../plugins/doctor-contract-registry.js";
import { createPluginManifestIdNormalizer } from "../plugins/plugin-manifest-id-normalizer.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry.js";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const cases: {
  plugins: NonNullable<OpenClawConfig["plugins"]>;
  reader: boolean;
  active: boolean;
}[] = [
  { plugins: { entries: { github: { enabled: false } } }, reader: false, active: true },
  { plugins: { allow: ["github"] }, reader: true, active: true },
  // These old allowlists excluded the standalone reader without an explicit plugin entry.
  { plugins: { allow: ["github-repositories"] }, reader: false, active: true },
  { plugins: { allow: ["telegram"] }, reader: false, active: true },
  { plugins: { deny: ["github"] }, reader: false, active: true },
  {
    plugins: { allow: ["telegram"], entries: { github: { enabled: true } } },
    reader: false,
    active: true,
  },
  {
    plugins: { allow: ["github"], entries: { "github-repositories": { enabled: false } } },
    reader: true,
    active: false,
  },
  { plugins: { allow: ["github"], deny: ["github-repositories"] }, reader: true, active: false },
  { plugins: { enabled: false, allow: ["github"] }, reader: true, active: false },
  {
    plugins: {
      entries: {
        github: { enabled: true },
        "github-repositories": { config: { reader: { enabled: false } } },
      },
    },
    reader: false,
    active: true,
  },
];

it.each(cases)(
  "preserves retired reader policy through canonical Doctor migration and normal activation: %j",
  async ({ plugins, reader, active }) => {
    await withTempHome(async () => {
      const raw = {
        plugins,
        tools: { github: { profileId: "ghp_11111111111111111111111111111111" } },
        gateway: {
          github: { host: "github.com", apiBaseUrl: "https://api.github.com" },
          controlUi: { github: { token: "synthetic-service-token" } },
        },
      };
      const before = structuredClone(raw);
      const registry = loadPluginManifestRegistryForPluginRegistry({
        config: { plugins: raw.plugins },
        includeDisabled: true,
      });
      expect(collectDoctorConfigRepairPluginIds(raw)).toContain("github-repositories");
      const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
      expect(migrated.config, JSON.stringify(migrated.warnings)).not.toBeNull();
      expect(migrated.partiallyValid).not.toBe(true);
      if (!migrated.config) {
        throw new Error("Reader policy migration was not admitted");
      }
      expect(migrated.config.plugins?.entries?.github).toBeUndefined();
      expect(migrated.config.plugins?.entries?.["github-repositories"]?.config).toMatchObject({
        reader: { enabled: reader },
      });
      expect(migrated.config.plugins?.entries?.["github-repositories"]?.config).toMatchObject({
        system: raw.tools?.github,
        host: raw.gateway?.github?.host,
        apiBaseUrl: raw.gateway?.github?.apiBaseUrl,
        service: raw.gateway?.controlUi?.github,
      });
      expect(migrated.config.tools).not.toHaveProperty("github");
      expect(migrated.config.gateway).not.toHaveProperty("github");
      expect(migrated.config.gateway?.controlUi).not.toHaveProperty("github");
      expect(migrated.config.plugins?.allow).toEqual(plugins.allow);
      expect(migrated.config.plugins?.deny).toEqual(plugins.deny);
      // Doctor follows the plugin transform with the existing generic configured-plugin repair.
      const repaired = applyPluginAutoEnable({
        config: migrated.config,
        env: {},
        manifestRegistry: registry,
      }).config;
      expect(repaired.plugins?.entries?.["github-repositories"]?.config).toMatchObject({
        reader: { enabled: reader },
      });
      const plugin = registry.plugins.find((entry) => entry.id === "github-repositories");
      if (!plugin) {
        throw new Error("Consolidated GitHub manifest was not discovered");
      }
      expect(
        resolveEffectivePluginActivationState({
          id: plugin.id,
          origin: plugin.origin,
          enabledByDefault: plugin.enabledByDefault,
          config: normalizePluginsConfigWithResolverCore(
            repaired.plugins,
            createPluginManifestIdNormalizer(registry),
          ),
          rootConfig: repaired,
        }).enabled,
      ).toBe(active);
      expect(raw).toEqual(before);
      const repeated = migrateLegacyConfig(repaired, { sourceConfigBeforeMigrations: repaired });
      // The migration owner returns no candidate when canonical input needs no repair.
      expect(repeated.config).toBeNull();
      expect(repeated.changes).toEqual([]);
    });
  },
);

it.each([
  { enabled: false, config: { unexpected: true } },
  { enabled: false, extraPolicy: true },
])("preserves unsupported retired reader configuration instead of guessing: %j", async (entry) => {
  await withTempHome(async () => {
    const raw = { plugins: { entries: { github: entry } } };
    const before = structuredClone(raw);
    const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(migrated.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("all original settings were preserved")]),
    );
    expect(raw).toEqual(before);
    expect(migrated.config?.plugins?.entries?.["github-repositories"]).toBeUndefined();
    if (migrated.config) {
      expect(migrated.config.plugins?.entries?.github).toEqual(entry);
    }
  });
});

// Only a tool policy mentions the retired ID: core Doctor discovery must still repair it.
it.each(["allow", "alsoAllow", "deny"] as const)(
  "preserves exact retired reader %s coverage without a plugin entry",
  async (field) => {
    await withTempHome(async () => {
      const tools = {
        [field]: [" GITHUB "],
        ...(field === "allow" ? { deny: ["github_read"] } : {}),
        ...(field === "alsoAllow" ? { profile: "minimal" as const } : {}),
      };
      const raw = { tools };
      const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
      expect(migrated.config?.tools?.[field]).toEqual(["github_read", "github_search"]);
      if (!migrated.config?.tools) {
        throw new Error("Tool-only reader policy was not migrated");
      }
      const policy =
        field === "alsoAllow"
          ? mergeAlsoAllowPolicy(
              resolveToolProfilePolicy("minimal"),
              migrated.config.tools.alsoAllow ?? [],
            )
          : migrated.config.tools;
      expect(isToolAllowedByPolicies("github_read", [policy])).toBe(field === "alsoAllow");
      expect(isToolAllowedByPolicies("github_search", [policy])).toBe(field !== "deny");
      expect(migrated.config.plugins?.entries?.["github-repositories"]).toBeUndefined();
      const repeated = migrateLegacyConfig(migrated.config, {
        sourceConfigBeforeMigrations: migrated.config,
      });
      expect(repeated.config).toBeNull();
      expect(repeated.changes).toEqual([]);
    });
  },
);
