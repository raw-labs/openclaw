import type { ControlUiSettingsContextV2 } from "openclaw/plugin-sdk/control-ui";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Current native writers remain canonical until the final GitHub configuration cutover. */
export function readSettingsIdentityConfig(
  context: ControlUiSettingsContextV2,
  agentId: string | null,
) {
  if (!context.props.configAvailable) {
    return null;
  }
  const agent = agentId ? context.readAgentConfig(agentId) : null;
  return {
    system: context.readConfig(["tools", "github"]),
    agent: isRecord(agent) && isRecord(agent.tools) ? agent.tools.github : undefined,
  };
}
