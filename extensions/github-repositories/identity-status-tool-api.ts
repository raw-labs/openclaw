import type { ToolsGitHubStatusResult } from "@openclaw/gateway-protocol";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";

export function createGitHubIdentityStatusTool(
  gateway: NonNullable<OpenClawPluginToolContext<2>["gateway"]>,
): AnyAgentTool {
  return {
    label: "GitHub Identity Status",
    name: "github_identity_status",
    description:
      "Inspect the secret-free effective GitHub account, credential health, Git author, expiry, and scopes for this agent. If setup or reconnection is needed, ask the operator to connect GitHub in Agent Settings.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const status = await gateway.call<ToolsGitHubStatusResult>("tools.github.status", {
        agentId: gateway.agentId,
        selectedScope: "agent",
      });
      const reconnect =
        status.effective.credentialState !== "available" ||
        ["expired", "failed", "unavailable"].includes(status.effective.refreshState);
      return jsonResult({
        ...status,
        ...(reconnect
          ? {
              nextAction:
                "Ask the operator to connect or reconnect GitHub under Settings → Agents → Tools.",
            }
          : {}),
      });
    },
  };
}
