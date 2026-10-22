import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import {
  mutateAgentScopedPluginConfig,
  type AgentLifecycleBinding,
} from "openclaw/plugin-sdk/config-mutation";
import { normalizeAgentIdStrict } from "openclaw/plugin-sdk/routing";
import {
  GITHUB_PLUGIN_ID,
  readGitHubPluginConfigValue,
  type GitHubToolIdentityConfig,
} from "./config-api.js";

export async function updateGitHubToolIdentityConfig(params: {
  scope: "system" | "agent";
  agentId: string;
  identity?: GitHubToolIdentityConfig;
  expectedIdentity?: GitHubToolIdentityConfig | null;
  agentLifecycleBinding?: AgentLifecycleBinding;
}): Promise<OpenClawConfig> {
  const normalized = normalizeAgentIdStrict(params.agentId);
  if (params.scope === "agent" && !normalized.ok) {
    throw new Error("GitHub identity requires a valid agent id.");
  }
  const agentId = normalized.ok ? normalized.value : params.agentId;
  return await mutateAgentScopedPluginConfig(
    {
      pluginId: GITHUB_PLUGIN_ID,
      ...(params.scope === "agent"
        ? {
            agent: {
              id: agentId,
              binding: params.agentLifecycleBinding,
              createIfMissing: Boolean(params.identity && !params.agentLifecycleBinding),
            },
          }
        : {}),
    },
    (current) => {
      const config = { ...readGitHubPluginConfigValue(current) };
      const previous = params.scope === "system" ? config.system : config.agents?.[agentId];
      if (
        params.expectedIdentity !== undefined &&
        !isDeepStrictEqual(previous ?? null, params.expectedIdentity)
      ) {
        throw new Error("GitHub identity changed while setup was in progress.");
      }
      if (params.scope === "system") {
        if (params.identity) {
          config.system = params.identity;
        } else {
          delete config.system;
        }
      } else if (params.identity) {
        const prior = config.agents?.[agentId];
        config.agents ??= {};
        config.agents[agentId] =
          prior?.allowInSandbox === undefined
            ? params.identity
            : { ...params.identity, allowInSandbox: prior.allowInSandbox };
      } else if (config.agents) {
        delete config.agents[agentId];
      }
      return config;
    },
  );
}
