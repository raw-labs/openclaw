/** Canonical admitted OAuth-record reads; the plugin owns credential selection and refresh policy. */
export {
  inspectGitHubOAuthRecord,
  listGitHubOAuthRecords,
} from "../agents/github-oauth-records.js";

export {
  createRepositoryOAuthStateHostV1,
  type RepositoryOAuthStateHostV1,
} from "../gateway/github-oauth-lifecycle-host.js";

export { consumeGitHubSetupHandoff } from "../secrets/store/secret-store.js";

export {
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
} from "../agents/agent-lifecycle-registry.js";
export type { AgentLifecycleBinding } from "../agents/agent-lifecycle-registry.js";
