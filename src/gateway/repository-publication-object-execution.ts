import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import { encodeGitHubPublicationRequester } from "../state/github-publication-requester.js";
import { isGitHubPublicationRequesterV2 } from "./github-publication-requester-capability.js";
import type { GitHubPublicationRequesterPolicyV2 } from "./github-publication-requester.js";
import {
  bindRepositoryGitHubPublicationCheckpointAsync,
  claimRepositoryGitHubPublicationAsync,
} from "./github-publication-store-async.js";
import type {
  GitHubPublicationTransitionAuthority,
  RepositoryGitHubPublicationExecutionAsync,
} from "./github-publication-store-async.js";
import { terminalRepositoryGitHubPublication } from "./github-repository-publication-store.js";
import type { RepositoryPublicationProvider } from "./repository-publication-engine-contract.js";
import { RepositoryPublicationRequesterUnavailableError } from "./repository-publication-engine-errors.js";
import { restoreGitHubPublicationRequester } from "./repository-publication-lazy.js";
import { executeRepositoryPublication } from "./repository-publication-object-dispatch.js";
import { settleDeniedRepositoryGitHubPublication } from "./repository-publication-object-recovery.js";
import {
  assertReceiptOwner,
  captureCheckpoint,
  prepareReceiptOwner,
} from "./repository-publication-object-workspace.js";
import type { PersonalGitHubSessionActionV2 } from "./repository-publication-personal.js";
import {
  bindPersonalPublisher,
  preparePersonalPublisher,
  assertPublicationChangePermission as assertGitHubPublicationWorkflowChangesAllowed,
} from "./repository-publication-policy.js";
import { projectGitHubPublicationResult } from "./repository-publication-receipt.js";

export function createRepositoryGitHubPublicationExecution(params: {
  provider: RepositoryPublicationProvider;
  instanceId: string;
  active: Map<string, string>;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  assertCurrent: () => void;
  prepareSource: (
    requester: Pick<GitHubPublicationRequesterPolicyV2, "prepareSource">,
    selector: Parameters<GitHubPublicationRequesterPolicyV2["prepareSource"]>[0],
  ) => ReturnType<GitHubPublicationRequesterPolicyV2["prepareSource"]>;
}) {
  const { provider } = params;
  const bindPersonalGitHubPublicationSelection = (
    ...args: Parameters<typeof bindPersonalPublisher> extends [unknown, ...infer Rest]
      ? Rest
      : never
  ) => bindPersonalPublisher(provider, ...args);
  const preparePersonalGitHubPublicationSelection = preparePersonalPublisher;
  const { instanceId, active, getCommittedRuntimeConfig, prepareSource } = params;
  return async (
    initial: RepositoryGitHubPublicationRow,
    context: {
      assertCustody: () => void;
      assertCurrent?: () => void;
      action?: PersonalGitHubSessionActionV2;
      requester?: GitHubPublicationRequesterPolicyV2;
    },
  ) => {
    let row = initial;
    if (terminalRepositoryGitHubPublication(row)) {
      return projectGitHubPublicationResult(row);
    }
    const { assertCustody, action } = context;
    assertCustody();
    const preparedOwner = await prepareReceiptOwner(row);
    using _ = { [Symbol.dispose]: () => preparedOwner.release() };
    assertCustody();
    context.assertCurrent?.();
    const { loaded } = assertReceiptOwner(row, preparedOwner);
    const bound =
      action && row.connection_generation
        ? await bindPersonalGitHubPublicationSelection(action, {
            generation: row.connection_generation,
            account: { accountId: row.identity_account_id, login: row.identity_login },
          })
        : undefined;
    if (
      (row.owner_profile_id !== null) !== Boolean(bound) ||
      (bound && bound.profileId !== row.identity_profile_id)
    ) {
      throw new Error("My GitHub publication owner changed.");
    }
    let requester: GitHubPublicationRequesterPolicyV2 | undefined;
    let releaseRequester: (() => void) | undefined;
    const getRequester = () => {
      if (!requester) {
        throw new RepositoryPublicationRequesterUnavailableError();
      }
      return requester;
    };
    const assertExecution = () => {
      // Classify source loss before personal preparation can turn it into a retryable error.
      assertReceiptOwner(row, preparedOwner);
      assertCustody();
      if (row.owner_profile_id === null) {
        getRequester().assertCurrent();
      }
      context.assertCurrent?.();
      bound?.assertCurrent();
    };
    const authority: GitHubPublicationTransitionAuthority = {
      assertAction: assertExecution,
      assertCustody: params.assertCurrent,
      prepareSource: () =>
        prepareSource(action ?? getRequester(), {
          agentId: row.agent_id,
          sessionKey: row.session_key,
          sessionId: row.session_id,
          lifecycleRevision: row.session_lifecycle_revision,
          repositoryWorkspaceId: row.workspace_id,
          repositoryBranch: row.branch,
          ...(action ? { personalOwnerProfileId: action.owner } : {}),
        }),
    };
    let execution: RepositoryGitHubPublicationExecutionAsync | undefined;
    const claimExecution = async () => {
      if (!execution) {
        execution = await claimRepositoryGitHubPublicationAsync(row, instanceId, authority);
        active.set(row.request_id, execution.row.execution_id!);
      }
      return execution;
    };
    try {
      if (row.owner_profile_id === null) {
        if (
          context.requester &&
          isGitHubPublicationRequesterV2(context.requester) &&
          encodeGitHubPublicationRequester(context.requester.snapshot) ===
            row.requester_authority_json
        ) {
          requester = context.requester;
        } else {
          const restored = await restoreGitHubPublicationRequester(
            row.requester_authority_json,
            { sessionKey: row.session_key, agentId: row.agent_id },
            getCommittedRuntimeConfig,
          );
          requester = restored;
          releaseRequester = restored.release;
        }
      }
      assertExecution();
      if (
        !row.checkpoint_ref &&
        row.owner_profile_id === null &&
        !assertReceiptOwner(row, preparedOwner).workspace.checkpointRef
      ) {
        return projectGitHubPublicationResult(row);
      }
      return await captureCheckpoint(
        row,
        assertExecution,
        async (facts, prepared) => {
          if (!row.checkpoint_ref) {
            row = await bindRepositoryGitHubPublicationCheckpointAsync(
              row,
              facts,
              prepared.authority,
            );
          }
          assertExecution();
          return await executeRepositoryPublication({
            provider,
            config: getCommittedRuntimeConfig(),
            source: assertReceiptOwner(row, preparedOwner).workspace,
            execution: await claimExecution(),
            snapshot: prepared.snapshot,
            snapshotRoot: prepared.snapshotRoot,
            storePath: loaded.storePath,
            readCurrentEntry: () => assertReceiptOwner(row, preparedOwner).loaded.entry,
            assertWorkflowChangesAllowed: bound
              ? assertExecution
              : () => assertGitHubPublicationWorkflowChangesAllowed(getRequester()),
            assertWorkspace: () => {
              assertReceiptOwner(row, preparedOwner);
            },
            validateAuthority: () => {
              assertExecution();
              return true;
            },
            ...(bound
              ? {
                  publisher: async () =>
                    (await preparePersonalGitHubPublicationSelection(bound, assertExecution)).lease,
                }
              : {}),
          });
        },
        authority,
      );
    } catch (error) {
      if (
        row.owner_profile_id === null &&
        error instanceof RepositoryPublicationRequesterUnavailableError
      ) {
        return await settleDeniedRepositoryGitHubPublication({
          provider,
          execution: await claimExecution(),
          assertCustody,
          error,
        });
      }
      if (execution?.ownsExecution()) {
        await execution.interrupt();
      }
      throw error;
    } finally {
      releaseRequester?.();
      if (execution) {
        active.delete(row.request_id);
      }
    }
  };
}
