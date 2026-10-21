import { isDeepStrictEqual } from "node:util";
import { resolveMutableAgentEntry, applyAgentConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  unsetConfigValueAtPath,
  mutateConfigFileWithRetry,
} from "openclaw/plugin-sdk/config-mutation";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
  type AgentLifecycleBinding,
} from "openclaw/plugin-sdk/repository-identity-host";
import type { GitHubToolIdentityConfig } from "./config-api.js";

export async function updateGitHubToolIdentityConfig(params: {
  scope: "system" | "agent";
  agentId: string;
  identity?: GitHubToolIdentityConfig;
  expectedIdentity?: GitHubToolIdentityConfig | null;
  agentLifecycleBinding?: AgentLifecycleBinding;
}): Promise<OpenClawConfig> {
  const mutation = await mutateConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    mutate: async (draft) => {
      if (params.scope === "system") {
        if (
          params.expectedIdentity !== undefined &&
          !isDeepStrictEqual(draft.tools?.github ?? null, params.expectedIdentity)
        ) {
          throw new Error("GitHub identity changed while setup was in progress.");
        }
        draft.tools ??= {};
        if (params.identity) {
          draft.tools.github = params.identity;
        } else {
          unsetConfigValueAtPath(draft, ["tools", "github"]);
        }
        return;
      }

      if (
        params.agentLifecycleBinding &&
        (!(await matchesAgentLifecycleBindingAsync(() => draft, params.agentLifecycleBinding)) ||
          !matchesAgentLifecycleBinding(draft, params.agentLifecycleBinding))
      ) {
        throw new Error("Agent changed while GitHub setup was in progress.");
      }
      let entry = resolveMutableAgentEntry(draft, params.agentId);
      if (params.agentLifecycleBinding && !entry) {
        throw new Error("Agent changed while GitHub setup was in progress.");
      }
      if (
        params.expectedIdentity !== undefined &&
        !isDeepStrictEqual(entry?.tools?.github ?? null, params.expectedIdentity)
      ) {
        throw new Error("GitHub identity changed while setup was in progress.");
      }
      if (!entry && params.identity && !params.agentLifecycleBinding) {
        Object.assign(draft, applyAgentConfig(draft, { agentId: params.agentId }));
        entry = resolveMutableAgentEntry(draft, params.agentId);
      }
      if (!entry) {
        return;
      }
      entry.tools ??= {};
      if (params.identity) {
        entry.tools.github =
          entry.tools.github?.allowInSandbox === undefined
            ? params.identity
            : { ...params.identity, allowInSandbox: entry.tools.github.allowInSandbox };
      } else {
        unsetConfigValueAtPath(entry, ["tools", "github"]);
      }
    },
  });
  return mutation.nextConfig;
}
