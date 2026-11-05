import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveConfiguredGitHubApiBaseUrl, resolveConfiguredGitHubHost } from "./host-api.js";
export { CLEARED_GITHUB_CREDENTIALS, withGitHubToken } from "./host-api.js";

export function resolveGitHubHost(): string {
  return resolveConfiguredGitHubHost(getRuntimeConfigSnapshot());
}

export function resolveGitHubApiBaseUrl(): string {
  return resolveConfiguredGitHubApiBaseUrl(getRuntimeConfigSnapshot());
}
