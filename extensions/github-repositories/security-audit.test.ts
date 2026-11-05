import { describe, expect, it } from "vitest";
import { collectConfigSecurityAuditFindings } from "./security-audit-api.js";

describe("GitHub config security audit", () => {
  it("warns for each agent opting its GitHub identity into sandboxed execution", async () => {
    const identity = { profileId: "ghp_0123456789abcdef0123456789abcdef" };
    const optedIn = { ...identity, allowInSandbox: true };
    const optedOut = { ...identity, allowInSandbox: false };
    const findings = (
      await collectConfigSecurityAuditFindings({
        env: {},
        sourceConfig: {},
        stateDir: "/synthetic/state",
        configPath: "/synthetic/openclaw.json",
        config: {
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
    ).filter((finding) => finding.checkId === "sandbox.github_identity_exposed");
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
    for (const finding of findings) {
      expect(finding.detail).toContain("sandboxed execution");
    }
  });
});
