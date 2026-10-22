import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { readGitHubAgentIdentity, readGitHubConfig } from "./config-api.js";

/** Account selection owns configured author metadata; reading it grants no execution authority. */
export function readConfiguredGitHubAuthor(config: OpenClawConfig, agentId: string) {
  return (readGitHubAgentIdentity(config, agentId) ?? readGitHubConfig(config).system)?.gitAuthor;
}
