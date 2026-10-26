import type { OpenClawPluginSecurityAuditCollector } from "openclaw/plugin-sdk/plugin-entry";
import { readGitHubConfig } from "./config-api.js";

/** Authored config facts only: no credential materialization, filesystem probes, or GitHub requests. */
export const collectConfigSecurityAuditFindings: OpenClawPluginSecurityAuditCollector = ({
  config,
}) => {
  const findings: Awaited<ReturnType<OpenClawPluginSecurityAuditCollector>> = [];
  for (const [agentId, identity] of Object.entries(readGitHubConfig(config).agents ?? {})) {
    if (identity.allowInSandbox !== true) {
      continue;
    }
    const configPath = `plugins.entries.github-repositories.config.agents.${agentId}.allowInSandbox`;
    findings.push({
      checkId: "sandbox.github_identity_exposed",
      severity: "warn",
      title: "Managed GitHub identity reaches sandboxed execution",
      detail:
        `${configPath}=true allows agent "${agentId}" to use its managed GitHub credentials ` +
        "and Git author in its own sandboxed execution. Commands in that sandbox can read and use the credentials.",
      remediation: `Set ${configPath}=false unless this agent's sandboxed code is trusted with its GitHub access.`,
    });
  }
  return findings;
};
