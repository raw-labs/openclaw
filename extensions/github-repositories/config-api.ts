import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { GITHUB_PLUGIN_ID } from "./host-api.js";
export type GitHubToolIdentityConfig = NonNullable<NonNullable<OpenClawConfig["tools"]>["github"]>;

/** Account/endpoint keys remain native; only the retired reader policy belongs to this plugin. */
export function readGitHubConfig(config?: OpenClawConfig | null) {
  const pluginConfig = asOptionalRecord(config?.plugins?.entries?.[GITHUB_PLUGIN_ID]?.config);
  return {
    ...config?.gateway?.github,
    system: config?.tools?.github,
    reader: asOptionalRecord(pluginConfig?.reader),
  };
}
export function readGitHubAgentIdentity(config: OpenClawConfig, agentId: string) {
  return resolveAgentConfig(config, agentId)?.tools?.github;
}
