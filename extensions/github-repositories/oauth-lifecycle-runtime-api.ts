import { createGitHubOAuthLifecycleV1 } from "./oauth-lifecycle-api.js";
import { createGitHubOAuthLifecycleHost } from "./oauth-lifecycle-host-api.js";

/** Vendor policy and transport are composed only inside the enabled plugin service. */
export function createGitHubOAuthLifecycle(
  params: Parameters<typeof createGitHubOAuthLifecycleV1>[1] & {
    scheduler: { readonly signal: AbortSignal };
  },
) {
  // Closing timers prevents new work; accepted refreshes retain record custody
  // until the OAuth owner has physically drained its non-idempotent exchanges.
  const settlement = new AbortController();
  return createGitHubOAuthLifecycleV1(createGitHubOAuthLifecycleHost(settlement.signal), {
    ...params,
    onDrained: () => settlement.abort(),
  });
}
