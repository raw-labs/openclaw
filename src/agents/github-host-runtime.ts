import {
  resolveConfiguredGitHubApiBaseUrl,
  resolveConfiguredGitHubHost,
} from "../../extensions/github-repositories/host-api.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
export {
  CLEARED_GITHUB_CREDENTIALS,
  withGitHubToken,
} from "../../extensions/github-repositories/host-api.js";

export function resolveGitHubHost(): string {
  return resolveConfiguredGitHubHost(getRuntimeConfigSnapshot());
}

export function resolveGitHubApiBaseUrl(): string {
  return resolveConfiguredGitHubApiBaseUrl(getRuntimeConfigSnapshot());
}
