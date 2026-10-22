import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { isSecretRef, isValidEnvSecretRefId } from "openclaw/plugin-sdk/secret-input";
import { CLEARED_GITHUB_CREDENTIALS } from "./host-runtime-api.js";
import type {
  GitHubToolIdentityConfig,
  PreparedGitHubToolEnvironment,
} from "./tool-identity.types-api.js";

export const AGENT_GIT_CONFIG_PARAMETERS = "'maintenance.auto=false' 'gc.auto=0'";

export { managedGitHubIdentityEnvironment } from "openclaw/plugin-sdk/worker-github-credentials";

/** Signing keys and preview credentials never enter agent child processes. */
export function githubCredentialEnvironmentExclusions(
  params: {
    config: OpenClawConfig;
    sourceConfig?: OpenClawConfig;
  },
  selected?: GitHubToolIdentityConfig,
) {
  const source = params.sourceConfig ?? params.config;
  const values = [
    source.gateway?.controlUi?.github?.token ?? params.config.gateway?.controlUi?.github?.token,
  ];
  // Every signing key belongs to the Gateway, even when this agent uses OAuth
  // or native credentials instead of the system or another agent's App.
  for (const identity of [
    source.tools?.github,
    ...Object.values(source.agents?.entries ?? {}).map((agent) => agent.tools?.github),
  ]) {
    if (identity?.kind === "app-installation") {
      values.push(identity.app.privateKey);
    }
  }
  const credentialScrubEnv: Record<string, string> = selected
    ? { ...CLEARED_GITHUB_CREDENTIALS }
    : {};
  const excludedStoreNames: string[] = [];
  for (const value of values) {
    if (!isSecretRef(value)) {
      continue;
    }
    if (value.source === "env" && isValidEnvSecretRefId(value.id)) {
      credentialScrubEnv[value.id] = "";
    } else if (value.source === "store") {
      credentialScrubEnv[value.id] = "";
      excludedStoreNames.push(value.id);
    }
  }
  return { credentialScrubEnv, excludedStoreNames };
}

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
