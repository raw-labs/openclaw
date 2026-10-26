import type { GitHubRepositoryAdmissionRequest } from "openclaw/plugin-sdk/repository-identity-host";
import type { GitHubToolIdentityConfig } from "./tool-identity.types-api.js";

export type GitHubAppSelection = Extract<GitHubToolIdentityConfig, { kind: "app-installation" }>;

export type { GitHubRepositoryAdmissionRequest } from "openclaw/plugin-sdk/repository-identity-host";
export type GitHubCredentialReader = (
  env: NodeJS.ProcessEnv,
  admission?: GitHubRepositoryAdmissionRequest,
) => Promise<string | undefined>;
