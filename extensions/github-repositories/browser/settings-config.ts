import type { ControlUiSettingsContextV2 } from "openclaw/plugin-sdk/control-ui";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Loaded empty configuration clears old identity drafts; unavailable facts preserve them. */
export function readSettingsIdentityConfig(
  context: ControlUiSettingsContextV2,
  agentId: string | null,
) {
  if (!context.props.configAvailable) {
    return null;
  }
  const value = context.readConfig(["plugins", "entries", "github-repositories", "config"]);
  const config = isRecord(value) ? value : undefined;
  const agents = isRecord(config?.agents) ? config.agents : null;
  return { system: config?.system, agent: agentId ? agents?.[agentId] : undefined };
}
