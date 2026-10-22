/** Browser read owner; inert until a plugin activation creates its runtime. */
export { createRepositoryBrowserRuntime } from "./browser/repository-runtime.ts";
export {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  summarizeSessionPullRequests,
  createSessionPullRequestStore,
} from "./browser/session-pull-requests.ts";
export type { SessionPullRequestSnapshotStore } from "./browser/session-pull-requests.ts";
