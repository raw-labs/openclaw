import { captureDashboardDataBindingRead } from "openclaw/plugin-sdk/dashboard";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveGitHubActionsRequest } from "./board-capabilities-api.js";

/** The saved legacy ID and scoped grants remain valid; only the active plugin serves them. */
export function registerGitHubBoardBinding(api: OpenClawPluginApi) {
  api.registerDashboardDataBinding({
    apiVersion: 1,
    id: "actions.runs",
    resolveGrant: (params) => resolveGitHubActionsRequest(params).capability,
    async prepare(host) {
      const { prepareBoardGitHubIdentity } = await import("./board-actions-api.js");
      const identity = await prepareBoardGitHubIdentity(host);
      return { assertCurrent: identity.assertSelected, start: identity.start };
    },
  });
  api.registerGatewayMethod(
    "github-repositories.board.actions.runs",
    async ({ params, respond }) => {
      const { readBoardGitHubActions } = await import("./board-actions-api.js");
      await readBoardGitHubActions(
        params,
        captureDashboardDataBindingRead(),
        (value) => respond(true, value),
        api.logger.warn,
      );
    },
    { scope: "operator.read", since: "2026.10.26", profileAccess: "independent" },
  );
}
