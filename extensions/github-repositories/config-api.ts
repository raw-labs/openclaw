import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
export type GitHubToolIdentityConfig = NonNullable<NonNullable<OpenClawConfig["tools"]>["github"]>;
export const GITHUB_PLUGIN_ID = "github-repositories";
/** The current config owner remains native until the atomic namespace cutover. */
export function readGitHubConfig(config?: OpenClawConfig | null) {
  return { ...config?.gateway?.github, system: config?.tools?.github };
}
export function readGitHubAgentIdentity(config: OpenClawConfig, agentId: string) {
  return resolveAgentConfig(config, agentId)?.tools?.github;
}
