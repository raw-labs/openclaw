import { resolveConfiguredGitHubHost } from "../../extensions/github-repositories/host-api.js";
import {
  cloneProjectCheckout,
  ensureProjectCheckoutCommit,
  refreshProjectCheckout,
} from "../../extensions/github-repositories/project-clone-runtime-api.js";
import { parseProjectGitUrl } from "../../extensions/github-repositories/project-url-api.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createManagedProjectCheckoutV1 } from "./project-clone.js";

// Native custody tests retain their direct database/environment fixtures; production
// plugin callers use the separate invocation-bound SDK without those selection options.
function checkout(config: OpenClawConfig) {
  return createManagedProjectCheckoutV1({
    resolveUrl: (url) => parseProjectGitUrl(url, resolveConfiguredGitHubHost(config)),
    invalidUrlMessage:
      "Use a GitHub HTTPS or git@github.com repository URL. Local paths and file URLs are not accepted.",
    clone: cloneProjectCheckout,
    ensureCommit: ensureProjectCheckoutCommit,
    refresh: refreshProjectCheckout,
  });
}
export function materializeProjectClone(
  ...args: Parameters<ReturnType<typeof checkout>["materialize"]>
) {
  return checkout(args[0].cfg).materialize(...args);
}
export function refreshProjectClone(...args: Parameters<ReturnType<typeof checkout>["refresh"]>) {
  return checkout({}).refresh(...args);
}
