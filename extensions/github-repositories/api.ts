import type { PluginDoctorHealthRegistrationHost } from "openclaw/plugin-sdk/health";
import { hasConfiguredGitHubApiCredential } from "./public-api.js";

/** Doctor loads this declared lightweight artifact, never the account service runtime. */
export function registerDoctorHealthChecks(host: PluginDoctorHealthRegistrationHost): void {
  const id = "github-repositories/project-access";
  host.registerHealthCheck({
    id,
    kind: "plugin",
    description: "GitHub project access credential configuration.",
    async detect(ctx) {
      if (hasConfiguredGitHubApiCredential(ctx.env ?? process.env, ctx.cfg)) {
        return [];
      }
      return [
        {
          checkId: id,
          severity: "info",
          message:
            "Set plugins.entries.github-repositories.config.service.token with plugins.entries.github-repositories.config.service.host matching plugins.entries.github-repositories.config.host for private project access. Public github.com can also use GH_TOKEN/GITHUB_TOKEN; otherwise search is public-only.",
        },
      ];
    },
  });
}
