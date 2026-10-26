import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitMergedPullHead } from "../infra/git-read-operations.js";
import { getInProcessGatewayRequestContext } from "../plugins/runtime/gateway-request-scope.js";
import { observeProjectedRepositorySession } from "./repository-session-read-source.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

/** Optional cap-ordering evidence; never starts a remote request or supplies removal authority. */
export async function readKnownWorktreeMergedHeads(
  record: ManagedWorktreeRecord,
  config: OpenClawConfig,
): Promise<readonly GitMergedPullHead[]> {
  if (record.ownerKind !== "session" || !record.ownerId) {
    return [];
  }
  const owner = getInProcessGatewayRequestContext();
  const presentation = owner?.repositorySessions?.presentation;
  const projection = getSessionRowProjection(owner);
  if (!owner || !presentation || !projection) {
    return [];
  }
  try {
    const requested = resolveRequestedSessionAgentId(config, record.ownerId);
    if (!requested.ok) {
      return [];
    }
    const query = { key: record.ownerId, agentId: requested.agentId };
    const observation = await withReadySessionRows(
      projection,
      () => [query],
      (read) => {
        const row = read.describe(query);
        const binding = row?.entry.worktree;
        if (
          !row ||
          binding?.id !== record.id ||
          binding.branch !== record.branch ||
          binding.repoRoot !== record.repoRoot
        ) {
          return undefined;
        }
        return observeProjectedRepositorySession(config, row);
      },
    );
    if (
      !observation ||
      getRuntimeConfig() !== config ||
      getInProcessGatewayRequestContext() !== owner ||
      getSessionRowProjection(owner) !== projection ||
      owner.repositorySessions?.presentation !== presentation
    ) {
      return [];
    }
    const heads = await presentation.knownMergedHeads(observation);
    return getRuntimeConfig() === config && owner.repositorySessions?.presentation === presentation
      ? heads
      : [];
  } catch {
    // Missing or revoked evidence affects ranking only; Git still classifies the candidate.
    return [];
  }
}
