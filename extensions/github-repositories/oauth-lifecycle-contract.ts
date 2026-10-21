import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/core";
import type { GitHubToolIdentityConfig } from "./config-api.js";
import type { GitHubOAuthLifecycleHostV1 } from "./oauth-lifecycle-host-api.js";
export type { GitHubOAuthLifecycleHostV1 } from "./oauth-lifecycle-host-api.js";
export type GitHubDeviceAuthorizationRecord = NonNullable<
  Awaited<ReturnType<GitHubOAuthLifecycleHostV1["records"]["readGitHubDeviceAuthorizationRecord"]>>
>;
export type GitHubOAuthRecord = Extract<
  Awaited<ReturnType<GitHubOAuthLifecycleHostV1["records"]["inspectGitHubOAuthRecord"]>>,
  {
    state: "valid";
  }
>["record"];
export type GitHubIdentityScope = GitHubDeviceAuthorizationRecord["scope"];
export type { GitHubToolIdentityConfig } from "./config-api.js";
export type ConfiguredOAuthIdentity = {
  scope: GitHubIdentityScope;
  agentId: string;
  identity: GitHubToolIdentityConfig & {
    kind: "oauth";
  };
};
export type MaintenanceScope = Pick<
  PluginServiceSchedulerV1,
  "signal" | "now" | "schedule" | "beginClose" | "stop"
>;
export type GitHubOAuthInventory = Awaited<
  ReturnType<ReturnType<GitHubOAuthLifecycleHostV1["inventory"]["createReader"]>["read"]>
>;
