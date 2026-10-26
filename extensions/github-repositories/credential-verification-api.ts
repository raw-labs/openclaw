import { clearGitHubCredentialVerificationCache as clearPluginVerificationCache } from "./oauth-api.js";
import { clearNativeGitHubTokenCache } from "./read-identity-api.js";

// The identity owner invalidates native credential reads alongside HTTP,
// token parsing, verification policy, and its bounded verification cache.
export function clearGitHubCredentialVerificationCache(): void {
  clearNativeGitHubTokenCache();
  clearPluginVerificationCache();
}
export {
  verifyGitHubCredential,
  requestGitHubOAuthDeviceCode,
  pollGitHubOAuthDeviceToken,
  refreshGitHubOAuthToken,
} from "./oauth-api.js";
export type { GitHubOAuthTokenPair } from "./oauth-api.js";
