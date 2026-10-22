import type { PreparedGitHubToolEnvironment } from "./tool-identity.types-api.js";

export const AGENT_GIT_CONFIG_PARAMETERS = "'maintenance.auto=false' 'gc.auto=0'";

export { managedGitHubIdentityEnvironment } from "openclaw/plugin-sdk/worker-github-credentials";

export function applyManagedGitHubIdentityEnvironment(
  env: NodeJS.ProcessEnv | undefined,
  overlay: PreparedGitHubToolEnvironment,
): NodeJS.ProcessEnv {
  return {
    ...(env ?? process.env),
    ...Object.fromEntries(Object.keys(overlay.credentialScrubEnv).map((name) => [name, undefined])),
    ...overlay.localIdentityEnv,
  };
}
