import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createGitHubIdentityStatusTool } from "./identity-status-tool-api.js";
import { createGitHubPublishTool } from "./publish-tool-api.js";

/** Tool availability derives from the admitted host, never a plugin-created session authority. */
export function registerGitHubAgentTools(api: OpenClawPluginApi): void {
  api.registerTool(
    {
      contextVersion: 2,
      create({ gateway }) {
        return gateway?.workspace.publicationAvailable !== undefined
          ? createGitHubIdentityStatusTool(gateway)
          : null;
      },
    },
    { name: "github_identity_status", workspaceAccess: false },
  );
  api.registerTool(
    {
      contextVersion: 2,
      create({ gateway }) {
        return gateway &&
          (gateway.workspace.publicationAvailable === true ||
            (gateway.workspace.publicationAvailable === false &&
              gateway.workspace.controlAvailable))
          ? createGitHubPublishTool(gateway)
          : null;
      },
    },
    { name: "github_publish", workspaceAccess: "execute" },
  );
}
