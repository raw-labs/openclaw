import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { registerOpenPullRequestAction } from "./session-open-pull-request.ts";
import { createGitHubTextReferenceProvider } from "./text-reference-api.ts";

export { createGitHubIdentity } from "./github-identity.ts";
export type { GitHubIdentity } from "./github-identity.ts";
export { GitHubIdentity as GitHubIdentityView } from "./github-identity-view.tsx";
export { SettingsContext, translator } from "./i18n.ts";
export { GitHubConnectionSetup as GitHubConnectionSetupView } from "./github-identity-view.tsx";
export type { GitHubAuthorizationState } from "./github-identity-shared.ts";
export { GitHubConnections } from "./github-connections.tsx";
export type { SettingsSource } from "./github-connections.tsx";
export { pluginId, settingsViews } from "./settings-views.tsx";
export { english as settingsEnglish } from "./settings-english.ts";

export default defineControlUiPlugin({
  id: "github-repositories",
  activate(host) {
    const stopAction = registerOpenPullRequestAction(host);
    const stopReferences = host.ui.registerTextReferenceProvider(
      createGitHubTextReferenceProvider(host),
    );
    return () => {
      stopReferences();
      stopAction();
    };
  },
});
