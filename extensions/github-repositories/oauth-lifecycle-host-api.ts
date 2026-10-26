import { createRepositoryOAuthStateHostV1 } from "openclaw/plugin-sdk/repository-identity-host";
import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import { assertGitHubCliAvailable } from "./cli-preflight-api.js";
import {
  clearGitHubCredentialVerificationCache,
  refreshGitHubOAuthToken,
} from "./credential-verification-api.js";
import { pollGitHubDeviceFlow, startGitHubDeviceFlow } from "./oauth-device-flow-api.js";
import { createPersonalGitHubOAuthLifecycle } from "./personal-oauth-api.js";
import { clearNativeGitHubTokenCache } from "./read-identity-api.js";
import {
  createManagedGitHubProfileId,
  GitHubAccountMismatchError,
  installManagedGitHubProfile,
  refreshManagedGitHubProfile,
  removeManagedGitHubProfile,
  resolveConfiguredGitHubToolIdentity,
  resolveGitHubToolIdentityStatus,
  resolveManagedGitHubProfileDir,
} from "./tool-identity-api.js";
import { updateGitHubToolIdentityConfig } from "./tool-identity-config-api.js";

/** The vendor owner composes transport and profile policy with lifecycle-bound host records. */
export function createGitHubOAuthLifecycleHost(signal: AbortSignal) {
  const state = createRepositoryOAuthStateHostV1(signal);
  return {
    ...state,
    profiles: {
      clearNativeGitHubTokenCache,
      createManagedGitHubProfileId,
      GitHubAccountMismatchError,
      installManagedGitHubProfile,
      refreshManagedGitHubProfile,
      removeManagedGitHubProfile,
      resolveConfiguredGitHubToolIdentity,
      resolveGitHubToolIdentityStatus,
      resolveManagedGitHubProfileDir,
      updateGitHubToolIdentityConfig,
    },
    transport: {
      clearGitHubCredentialVerificationCache,
      refreshGitHubOAuthToken,
      assertGitHubCliAvailable,
      pollGitHubDeviceFlow,
      startGitHubDeviceFlow,
    },
    personal: { createPersonalGitHubOAuthLifecycle },
    utilities: { ...state.utilities, formatErrorMessage },
  };
}
export type GitHubOAuthLifecycleHostV1 = ReturnType<typeof createGitHubOAuthLifecycleHost>;
