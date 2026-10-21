/** Canonical native personal-account records. Storage admission and commit publication stay with their existing worker owner. */
export {
  prepareUserGitHubConnection,
  readUserGitHubConnectionAsync,
  readCanonicalUserGitHubConnectionAsync,
  listUserGitHubConnectionsAsync,
} from "../state/user-github-connections.js";
export type {
  UserGitHubConnection,
  UserGitHubConnected,
  UserGitHubDevice,
} from "../state/user-github-connections.js";
export { createRepositoryPersonalAccountHostV1 } from "../state/repository-personal-account-host.js";

// Released synchronous personal OAuth members retain their existing native adapter through 2026-12-31.
export {
  cancelUserGitHubAuthorizationSync,
  disconnectUserGitHubConnectionSync,
} from "../state/user-github-connections.js";
