import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import repositoryManifest from "../../extensions/github-repositories/openclaw.plugin.json" with { type: "json" };
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import * as metadata from "../plugins/plugin-registry.js";
import * as publicSurface from "../plugins/public-surface-loader.js";
import * as runtimeLoader from "../plugins/runtime/metadata-registry-loader.js";
import { runSecurityAuditCore } from "./audit.js";

afterEach(() => vi.restoreAllMocks());

function selectGitHubConfigAudit() {
  const rootDir = fileURLToPath(new URL("../../extensions/github-repositories/", import.meta.url));
  vi.spyOn(metadata, "loadPluginManifestRegistryForPluginRegistry").mockReturnValue({
    plugins: [
      createPluginManifestRecordFixture({
        id: repositoryManifest.id,
        rootDir,
        origin: "bundled",
        enabledByDefault: repositoryManifest.enabledByDefault,
        securityAuditConfig: repositoryManifest.securityAuditConfig,
      }),
    ],
    diagnostics: [],
  });
  return vi.spyOn(runtimeLoader, "loadPluginMetadataRegistrySnapshot").mockImplementation(() => {
    throw new Error("plain config audit must not activate a plugin entrypoint");
  });
}

it("warns for each agent opting its GitHub identity into sandboxed execution", async () => {
  const runtime = selectGitHubConfigAudit();
  const identity = { profileId: "ghp_0123456789abcdef0123456789abcdef" };
  const optedIn = { ...identity, allowInSandbox: true };
  const optedOut = { ...identity, allowInSandbox: false };
  const findings = (
    await runSecurityAuditCore({
      includeFilesystem: false,
      includeChannelSecurity: false,
      env: {},
      config: {
        agents: {
          ownership: "explicit",
          entries: {
            unconfigured: {},
            release: { tools: {} },
            maintenance: { tools: {} },
            disabled: { tools: {} },
            default: { tools: {} },
          },
        },
        plugins: {
          entries: {
            "github-repositories": {
              config: {
                agents: {
                  release: optedIn,
                  maintenance: optedIn,
                  disabled: optedOut,
                  default: identity,
                },
              },
            },
          },
        },
      },
    })
  ).findings.filter((finding) => finding.checkId === "sandbox.github_identity_exposed");
  expect(findings).toEqual(
    ["release", "maintenance"].map((agentId) =>
      expect.objectContaining({
        checkId: "sandbox.github_identity_exposed",
        severity: "warn",
        detail: expect.stringContaining(
          `plugins.entries.github-repositories.config.agents.${agentId}.allowInSandbox`,
        ),
        remediation: expect.stringContaining(
          `plugins.entries.github-repositories.config.agents.${agentId}.allowInSandbox`,
        ),
      }),
    ),
  );
  expect(runtime).not.toHaveBeenCalled();
  for (const finding of findings) {
    expect(finding.detail).toContain("sandboxed execution");
  }
});

it("skips a disabled GitHub config collector before loading its public artifact", async () => {
  selectGitHubConfigAudit();
  const artifact = vi.spyOn(publicSurface, "loadPluginPublicArtifactModuleSync");
  const report = await runSecurityAuditCore({
    config: {
      plugins: {
        entries: {
          "github-repositories": {
            enabled: false,
            config: {
              agents: {
                release: {
                  profileId: "ghp_0123456789abcdef0123456789abcdef",
                  allowInSandbox: true,
                },
              },
            },
          },
        },
      },
    },
    env: {},
    includeFilesystem: false,
    includeChannelSecurity: false,
  });
  expect(
    report.findings.some((finding) => finding.checkId === "sandbox.github_identity_exposed"),
  ).toBe(false);
  expect(artifact).not.toHaveBeenCalled();
});
