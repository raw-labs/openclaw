import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  listAgentEntries,
  tryResolveLegacyCompatibilityAgentId,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import { pinLegacyInheritedAuthOwnerForRosterTransition } from "../agents/legacy-inherited-auth-dir.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { IdentityConfig } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
type AgentEntry = AgentConfig;
export function findAgentEntryIndex(list: AgentEntry[], agentId: string): number {
  const id = normalizeAgentId(agentId);
  return list.findIndex((entry) => normalizeAgentId(entry.id) === id);
}

export function applyAgentConfig(
  cfg: OpenClawConfig,
  params: {
    agentId: string;
    name?: string;
    workspace?: string;
    agentDir?: string;
    model?: string | null;
    identity?: IdentityConfig;
  },
): OpenClawConfig {
  const agentId = normalizeAgentId(params.agentId);
  const list = listAgentEntries(cfg);
  const index = findAgentEntryIndex(list, agentId);
  const base = (index >= 0 ? list[index] : undefined) ?? { id: agentId };
  const previousName = normalizeOptionalString(base.name);
  // Follow identity renames only while the roster label shares that identity;
  // a distinct operator label keeps its separate meaning.
  const name =
    normalizeOptionalString(params.name) ??
    (previousName && previousName === normalizeOptionalString(base.identity?.name)
      ? normalizeOptionalString(params.identity?.name)
      : undefined);
  const mergedIdentity = params.identity ? { ...base.identity, ...params.identity } : undefined;
  const nextEntry: AgentEntry = {
    ...base,
    ...(name ? { name } : {}),
    ...(params.workspace ? { workspace: params.workspace } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(mergedIdentity ? { identity: mergedIdentity } : {}),
  };
  // Model is tri-state: omission preserves the override, null restores inheritance.
  if (params.model === null) {
    delete nextEntry.model;
  } else if (params.model !== undefined) {
    nextEntry.model = params.model;
  }
  const nextList = [...list];
  if (index >= 0) {
    nextList[index] = nextEntry;
  } else {
    nextList.push(nextEntry);
  }
  const { ownership: _ownership, ...agentsConfig } = cfg.agents ?? {};
  const nextConfig: OpenClawConfig = {
    ...cfg,
    agents: {
      ...agentsConfig,
      ...(nextList.length > 1 ? { ownership: "explicit" as const } : {}),
      entries: toAgentEntriesRecord(nextList),
    },
  };
  if (list.length !== 1 || nextList.length <= 1) {
    return nextConfig;
  }
  const priorSystemAgentId = tryResolveLegacyCompatibilityAgentId(cfg);
  const transitionedConfig =
    priorSystemAgentId &&
    !normalizeOptionalString(nextConfig.agents?.defaults?.systemAgent?.agentId)
      ? {
          ...nextConfig,
          agents: {
            ...nextConfig.agents,
            defaults: {
              ...nextConfig.agents?.defaults,
              systemAgent: { agentId: priorSystemAgentId },
            },
          },
        }
      : nextConfig;
  return pinLegacyInheritedAuthOwnerForRosterTransition(cfg, transitionedConfig);
}
