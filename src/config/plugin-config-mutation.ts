import {
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
  type AgentLifecycleBinding,
} from "../agents/agent-lifecycle-binding.js";
import { resolveMutableAgentEntry } from "../agents/agent-scope-config.js";
import { applyAgentConfig } from "../commands/agents.config-edit.js";
import { mutateConfigFileWithRetry } from "./mutate.js";

export type AgentScopedPluginConfigMutation = {
  pluginId: string;
  agent?: { id: string; binding?: AgentLifecycleBinding; createIfMissing: boolean };
};

/** Config owns retries, include boundaries and agent existence; a plugin changes only its canonical block. */
export async function mutateAgentScopedPluginConfig(
  params: AgentScopedPluginConfigMutation,
  mutate: (
    current: Readonly<Record<string, unknown>> | undefined,
  ) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>,
) {
  const mutation = await mutateConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    mutate: async (draft) => {
      const agent = params.agent;
      if (
        agent?.binding &&
        (agent.binding.agentId !== agent.id ||
          !(await matchesAgentLifecycleBindingAsync(() => draft, agent.binding)) ||
          !matchesAgentLifecycleBinding(draft, agent.binding))
      ) {
        throw new Error("Agent changed while plugin setup was in progress.");
      }
      let entry = agent && resolveMutableAgentEntry(draft, agent.id);
      if (agent?.binding && !entry) {
        throw new Error("Agent changed while plugin setup was in progress.");
      }
      const current = draft.plugins?.entries?.[params.pluginId]?.config;
      // Run the plugin's compare-and-set before creating an absent agent or publishing a block.
      const next = await mutate(structuredClone(current));
      if (agent) {
        if (agent.binding && !matchesAgentLifecycleBinding(draft, agent.binding)) {
          throw new Error("Agent changed while plugin setup was in progress.");
        }
        if (!entry && agent.createIfMissing && !agent.binding) {
          Object.assign(draft, applyAgentConfig(draft, { agentId: agent.id }));
          entry = resolveMutableAgentEntry(draft, agent.id);
        }
        if (!entry) {
          return;
        }
      }
      draft.plugins ??= {};
      draft.plugins.entries ??= {};
      const plugin = (draft.plugins.entries[params.pluginId] ??= {});
      plugin.config = next;
    },
  });
  return mutation.nextConfig;
}
