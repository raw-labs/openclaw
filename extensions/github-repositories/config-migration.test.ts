import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { readGitHubConfig } from "./config-api.js";
import { normalizeCompatibilityConfig } from "./doctor-contract-api.js";

// Doctor supplies raw legacy config before validating the canonical schema.
const migrate = (config: Record<string, unknown>) =>
  normalizeCompatibilityConfig({ cfg: config as OpenClawConfig });
const system = { profileId: "ghp_77777777777777777777777777777777", kind: "oauth" };

describe("GitHub canonical configuration migration", () => {
  it("moves native execution and service settings without changing reader policy", () => {
    const source = {
      tools: { github: system, exec: { timeoutSec: 15 } },
      agents: { entries: { build: { tools: { github: { ...system, allowInSandbox: false } } } } },
      gateway: {
        github: { host: "github.com", apiBaseUrl: "https://api.github.com" },
        controlUi: {
          github: {
            host: "${LEGACY_GITHUB_SERVICE_HOST}",
            token: { source: "store", provider: "default", id: "TEAM_GITHUB" },
          },
        },
        projects: {
          nativeGitHubSearch: false,
          defaultRepository: { url: "https://github.com/team/project" },
        },
      },
      plugins: { allow: ["memory-core"], entries: { github: { enabled: false } } },
    };
    const before = structuredClone(source);
    const result = migrate(source);
    expect(source).toEqual(before);
    expect(result.config.plugins?.allow).toEqual(["memory-core"]);
    expect(result.config.plugins?.entries?.["github-repositories"]?.config).toEqual({
      system,
      agents: { build: { ...system, allowInSandbox: false } },
      host: "github.com",
      apiBaseUrl: "https://api.github.com",
      service: {
        host: "${LEGACY_GITHUB_SERVICE_HOST}",
        token: { source: "store", provider: "default", id: "TEAM_GITHUB" },
      },
      repositorySearch: { useNativeCredentials: false },
    });
    expect(result.config.plugins?.entries?.["github-repositories"]?.enabled).toBeUndefined();
    expect(result.config.tools).toEqual({ exec: { timeoutSec: 15 } });
    expect(result.config.gateway?.projects?.defaultRepository).toEqual({
      url: "https://github.com/team/project",
    });
    expect(result.config.plugins?.entries?.github).toEqual(source.plugins.entries.github);
    expect(result.warnings?.join(" ")).toContain("did not widen the allowlist");
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it("keeps explicit canonical identities atomic and reports a conflict without credential values", () => {
    const legacy = { ...system, gitAuthor: { name: "Old operator" } };
    const canonical = { profileId: "ghp_88888888888888888888888888888888", kind: "oauth" };
    const result = migrate({
      tools: { github: legacy },
      plugins: {
        entries: { "github-repositories": { enabled: false, config: { system: canonical } } },
      },
    });
    expect(result.config.plugins?.entries?.["github-repositories"]).toEqual({
      enabled: false,
      config: { system: canonical },
    });
    expect(result.config.tools).toEqual({});
    expect(result.warnings?.join(" ")).toContain("conflicting tools.github");
    expect(JSON.stringify(result.warnings)).not.toContain(canonical.profileId);
    expect(JSON.stringify(result.warnings)).not.toContain(legacy.profileId);
  });

  it("keeps a canonical agent selection when a differently cased legacy roster key conflicts", () => {
    const canonical = { profileId: "ghp_88888888888888888888888888888888" };
    const result = migrate({
      agents: { entries: { Build: { tools: { github: system } } } },
      plugins: {
        entries: { "github-repositories": { config: { agents: { build: canonical } } } },
      },
    });
    expect(readGitHubConfig(result.config).agents).toEqual({ build: canonical });
    expect(result.warnings?.join(" ")).toContain("conflicting agents.entries.Build.tools.github");
    expect(JSON.stringify(result.warnings)).not.toContain(canonical.profileId);
    expect(JSON.stringify(result.warnings)).not.toContain(system.profileId);
  });

  it("rejects colliding legacy agent identities without changing the authored input", () => {
    const source = {
      agents: {
        entries: {
          Build: { tools: { github: system } },
          build: { tools: { github: { profileId: "ghp_88888888888888888888888888888888" } } },
        },
      },
    };
    const before = structuredClone(source);
    expect(() => migrate(source)).toThrow(/collid/i);
    expect(source).toEqual(before);
  });

  it("never binds an explicit canonical service token to a legacy credential host", () => {
    const canonical = { token: "synthetic-canonical-public-token" };
    const result = migrate({
      plugins: { entries: { "github-repositories": { config: { service: canonical } } } },
      gateway: {
        controlUi: {
          github: { host: "ghe.example.test", token: "synthetic-legacy-enterprise-token" },
        },
      },
    });
    expect(readGitHubConfig(result.config).service).toEqual(canonical);
    expect(result.config.gateway?.controlUi).not.toHaveProperty("github");
    expect(result.warnings?.join(" ")).toContain("one credential/host selection");
    expect(JSON.stringify(result.warnings)).not.toContain("synthetic-");
    expect(normalizeCompatibilityConfig({ cfg: result.config }).changes).toEqual([]);
  });

  it("never fills a partial canonical endpoint with a legacy API destination", () => {
    const result = migrate({
      plugins: {
        entries: { "github-repositories": { config: { host: "canonical.example.test" } } },
      },
      gateway: {
        github: { host: "legacy.example.test", apiBaseUrl: "https://legacy.example.test/api/v3" },
      },
    });
    expect(readGitHubConfig(result.config)).toEqual({ host: "canonical.example.test" });
    expect(result.config.gateway).not.toHaveProperty("github");
    expect(result.warnings?.join(" ")).toContain("one endpoint selection");
    expect(JSON.stringify(result.warnings)).not.toContain("legacy.example.test");
    expect(normalizeCompatibilityConfig({ cfg: result.config }).changes).toEqual([]);
  });

  it("preserves the independent reader plugin permissions during native migration", () => {
    const source = {
      tools: { github: system },
      plugins: {
        entries: { github: { enabled: false, hooks: { allowConversationAccess: false } } },
      },
    };
    const result = migrate(source);
    expect(result.config.plugins?.entries?.github).toEqual(source.plugins.entries.github);
    expect(readGitHubConfig(result.config).system).toEqual(system);
    expect(source.tools.github).toEqual(system);
  });

  it("retains unrelated malformed legacy fields instead of silently discarding them", () => {
    const result = migrate({
      gateway: {
        github: { host: "github.com", apiBaseUrl: "https://api.github.com", futureField: "keep" },
      },
    });
    expect((result.config.gateway as Record<string, unknown>).github).toEqual({
      futureField: "keep",
    });
    expect(result.warnings?.join(" ")).toContain("Unrecognized legacy gateway.github");
  });
  it.each([{ policy: { deny: ["github"] } }, { policy: { allow: ["github", "memory-core"] } }])(
    "leaves the existing reader policy untouched when no native settings need migration: %j",
    ({ policy }) => {
      const authored = { plugins: policy };
      const result = normalizeCompatibilityConfig({ cfg: authored });
      expect(result.config.plugins?.allow).toEqual("allow" in policy ? policy.allow : undefined);
      expect(result.config.plugins?.deny).toEqual("deny" in policy ? policy.deny : undefined);
      expect(result).toEqual({ config: authored, changes: [] });
      expect(normalizeCompatibilityConfig({ cfg: result.config }).changes).toEqual([]);
    },
  );
});
