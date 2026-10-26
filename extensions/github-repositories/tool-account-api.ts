import { stringify as stringifyYaml } from "yaml";
import { resolveConfiguredGitHubHost } from "./host-api.js";

export type { GitHubToolAccount } from "openclaw/plugin-sdk/repository-identity-host";

export function managedGitHubHosts(identity: { login: string; token: string }): string {
  return stringifyYaml({
    [resolveConfiguredGitHubHost()]: {
      user: identity.login,
      oauth_token: identity.token,
      users: { [identity.login]: { oauth_token: identity.token } },
    },
  });
}
