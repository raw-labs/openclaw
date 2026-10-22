import { parseProjectGitUrl } from "../../extensions/github-repositories/project-url-api.js";
import { resolveGitHubHost } from "../agents/github-host-runtime.js";

/** Gateway admission binds repository URLs to the selected GitHub host. */
export function parseConfiguredProjectGitUrl(raw: string) {
  return parseProjectGitUrl(raw, resolveGitHubHost());
}
