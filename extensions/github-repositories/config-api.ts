import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SecretInput } from "openclaw/plugin-sdk/secret-ref-runtime";

export const GITHUB_PLUGIN_ID = "github-repositories";
export const GITHUB_CONFIG_PATH = "plugins.entries.github-repositories.config";

export type GitHubGitAuthor = { name?: string; email?: string };
export type GitHubToolIdentityConfig = {
  profileId: string;
  gitAuthor?: GitHubGitAuthor;
} & (
  | { kind?: "oauth" }
  | {
      kind: "app-installation";
      app: {
        appId: number;
        installationId: number;
        accountId: number;
        repositories: { id: number; fullName: string }[];
        permissions: Record<string, "read" | "write">;
        privateKey: SecretInput;
        keyVersion: string;
      };
    }
);
export type AgentGitHubToolIdentityConfig = GitHubToolIdentityConfig & {
  allowInSandbox?: boolean;
};
export type GitHubPluginConfig = {
  host?: string;
  apiBaseUrl?: string;
  service?: { host?: string; token?: SecretInput };
  system?: GitHubToolIdentityConfig;
  agents?: Record<string, AgentGitHubToolIdentityConfig>;
  repositorySearch?: { useNativeCredentials?: boolean };
};
const EMPTY_CONFIG: GitHubPluginConfig = Object.freeze({});

/** The plugin manifest admits this canonical shape before runtime; legacy keys belong to Doctor. */
export function readGitHubConfig(config?: OpenClawConfig | null): GitHubPluginConfig {
  return readGitHubPluginConfigValue(config?.plugins?.entries?.[GITHUB_PLUGIN_ID]?.config);
}

/** The manifest has already admitted this canonical block; it is also the scoped writer's input. */
export function readGitHubPluginConfigValue(value: unknown): GitHubPluginConfig {
  return (value as GitHubPluginConfig | undefined) ?? EMPTY_CONFIG;
}

export function readGitHubAgentIdentity(
  config: OpenClawConfig,
  agentId: string,
): AgentGitHubToolIdentityConfig | undefined {
  return readGitHubConfig(config).agents?.[agentId];
}
