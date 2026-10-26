export type { GitHubToolAccount } from "./github-oauth-records.js";
import { stringify as stringifyYaml } from "yaml";
import { resolveConfiguredGitHubHost } from "./github-host.js";

export function managedGitHubHosts(identity: { login: string; token: string }): string {
  return stringifyYaml({
    [resolveConfiguredGitHubHost()]: {
      user: identity.login,
      oauth_token: identity.token,
      users: { [identity.login]: { oauth_token: identity.token } },
    },
  });
}
