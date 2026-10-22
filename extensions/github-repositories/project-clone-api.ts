import { captureRepositoryServiceHost } from "openclaw/plugin-sdk/repository-session-host";
import { createManagedProjectCheckoutV1 } from "openclaw/plugin-sdk/repository-sources";
import { resolveConfiguredGitHubHost } from "./host-api.js";
import {
  cloneProjectCheckout,
  ensureProjectCheckoutCommit,
  refreshProjectCheckout,
} from "./project-clone-runtime-api.js";
import { parseProjectGitUrl } from "./project-url-api.js";
const checkout = createManagedProjectCheckoutV1({
  resolveUrl: (url) => {
    const host = captureRepositoryServiceHost();
    if (!host) {
      throw new Error("GitHub checkout requires an admitted Gateway binding.");
    }
    host.assertCurrent();
    return parseProjectGitUrl(url, resolveConfiguredGitHubHost(host.getConfig()));
  },
  invalidUrlMessage:
    "Use a GitHub HTTPS or git@github.com repository URL. Local paths and file URLs are not accepted.",
  clone: cloneProjectCheckout,
  ensureCommit: ensureProjectCheckoutCommit,
  refresh: refreshProjectCheckout,
});
export const materializeProjectClone = checkout.materialize;
export const refreshProjectClone = checkout.refresh;
