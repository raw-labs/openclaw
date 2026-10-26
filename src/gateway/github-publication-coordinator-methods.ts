import { randomUUID } from "node:crypto";
import type {
  GitHubPublicationPublisher,
  SessionGitHubPublicationResult,
  SessionGitHubPublishParams,
  SessionGitHubStatusResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GitHubPublicationRow as PublicationRow } from "../state/github-publication-read.types.js";
import { readGitHubPublicationSessionLifecycleInWorker } from "../state/github-publication-session-lifecycles.js";
import {
  readGitHubPublicationWorktreeOwner,
  type PublicationSessionIdentity,
  prepareGitHubPublicationSession,
} from "./github-publication-availability.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "./github-publication-git-transport.js";
import {
  matchesCurrentPublisher,
  prepareCurrentPublisher,
  assertExpectedPublisher as assertExpectedSharedGitHubPublisher,
} from "./github-publication-policy.js";
import {
  digestGitHubPublicationRequest as digestRequest,
  projectGitHubPublicationResult as publicationResult,
} from "./github-publication-receipt.js";
import { readGitHubPublicationRequestInWorker } from "./github-publication-recovery.js";
import { insertGitHubPublicationRequestAsync } from "./github-publication-request-async.js";
import { isGitHubPublicationRequesterV2 } from "./github-publication-requester-capability.js";
import type {
  GitHubPublicationRequester,
  GitHubPublicationRequesterV2,
} from "./github-publication-requester.js";
import { readSharedGitHubPublication } from "./github-publication-shared-read.js";
import { bindGitHubPublicationSourceLifetime } from "./github-publication-source.js";
import {
  deferGitHubPublicationRequestsAsync,
  listGitHubPublicationsForClaimAsync,
  listSharedGitHubPublicationsAsync,
  listUnreportedPersonalGitHubPublicationsAsync,
  readGitHubPublicationRequestAsync,
} from "./github-publication-store-async.js";
import type { RepositoryPublicationProvider } from "./repository-publication-contract.js";
import { projectWorkerSessionTurnClaim } from "./worker-environments/placement-record.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

/** @deprecated Use GitHubPublicationClaimRequestV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
export type GitHubPublicationClaimRequest = {
  claim: WorkerSessionTurnClaim;
  sessionKey: string;
  agentId: string;
  idempotencyKey: string;
  title?: string;
  body?: string;
  draft?: boolean;
  requester: GitHubPublicationRequester;
  expectedPublisher?: GitHubPublicationPublisher;
};

/** @deprecated Use GitHubPublicationSessionRequestV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
export type GitHubPublicationSessionRequest = SessionGitHubPublishParams & {
  agentId: string;
  expectedRunId?: string;
  requester: GitHubPublicationRequester;
};

export type GitHubPublicationClaimRequestV2 = Omit<GitHubPublicationClaimRequest, "requester"> & {
  requester: GitHubPublicationRequesterV2;
};
export type GitHubPublicationSessionRequestV2 = Omit<
  GitHubPublicationSessionRequest,
  "requester"
> & { requester: GitHubPublicationRequesterV2 };

export function exactClaimForPlacement(
  placement: NonNullable<ReturnType<WorkerSessionPlacementStore["get"]>>,
): WorkerSessionTurnClaim | undefined {
  const claim = placement.turnClaim;
  if (claim?.owner !== "local") {
    return projectWorkerSessionTurnClaim(placement);
  }
  return {
    sessionId: placement.sessionId,
    claimId: claim.claimId,
    runId: claim.runId,
    placementGeneration: claim.generation,
    owner: {
      kind: "local",
      ...(placement.environmentId ? { environmentId: placement.environmentId } : {}),
      ...(placement.activeOwnerEpoch !== null ? { ownerEpoch: placement.activeOwnerEpoch } : {}),
    },
  };
}

export function createGitHubPublicationCoordinatorMethods(params: {
  provider: RepositoryPublicationProvider;
  placements: WorkerSessionPlacementStore;
  assertCurrent: () => void;
  requestForClaimV2: (
    request: GitHubPublicationClaimRequestV2,
  ) => Promise<SessionGitHubPublicationResult>;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  signal: AbortSignal;
  sameWorktree: (
    row: PublicationRow,
    worktree: Awaited<ReturnType<typeof readGitHubPublicationWorktreeOwner>>["worktree"],
    publicationBranch?: string,
  ) => boolean;
  processRow: (
    initial: PublicationRow,
    validateExecution: () => boolean,
    assertInvocationCurrent?: () => void,
    invocationSignal?: AbortSignal,
  ) => Promise<SessionGitHubPublicationResult>;
  recordRequestingRun: (requestId: string, runId: string) => void;
}) {
  const { provider } = params;
  const prepareCurrentGitHubPublicationIdentity = (agentId: string) =>
    prepareCurrentPublisher(provider, agentId);
  const { sameWorktree, processRow } = params;
  const requestForSession = async (
    input: GitHubPublicationSessionRequestV2,
  ): Promise<SessionGitHubPublicationResult> => {
    if (input.selection?.source === "personal") {
      throw new Error("My GitHub publication requires direct personal authorization.");
    }
    const expected = input.selection?.expected;
    const assertRequester = input.requester.assertCurrent;
    if (!input.sessionKey) {
      throw new Error("GitHub publication requires an authoritative session.");
    }
    assertRequester();
    // Inline processing completes during the requesting run's tool call; its
    // transcript notice belongs to that run rather than splitting the turn.
    const processDuringRun = async (row: PublicationRow, validateExecution: () => boolean) => {
      if (input.expectedRunId) {
        params.recordRequestingRun(row.request_id, input.expectedRunId);
      }
      try {
        return await processRow(
          row,
          validateExecution,
          input.requester.assertInvocationCurrent,
          input.requester.signal,
        );
      } catch (error) {
        if (
          !(error instanceof GitHubPublicationRecoveryPendingError) ||
          !initialAuthority.loaded.entry.worktree?.githubPullRequest
        ) {
          throw error;
        }
        // Native recovery retains this accepted request; a new tool call has a different key.
        params.assertCurrent();
        assertRequester();
        const retained = await readSharedGitHubPublication(session, { requestId: row.request_id });
        params.assertCurrent();
        assertRequester();
        if (!retained) {
          throw error;
        }
        const result = publicationResult(retained);
        return result.status === "requested" || result.status === "publishing"
          ? {
              ...result,
              message:
                "The original PR publication is awaiting confirmation. Finish the turn and wait for this request's result in the conversation; do not submit another publication to recover it.",
            }
          : result;
      }
    };
    using selectedSession = await prepareGitHubPublicationSession(input.sessionKey, {
      cfg: params.getCommittedRuntimeConfig(),
      agentId: input.agentId,
      assertCurrent: params.assertCurrent,
    });
    const initialLoaded = selectedSession.loaded;
    const sessionId = initialLoaded.entry?.sessionId;
    if (!sessionId) {
      throw new Error("GitHub publication session changed.");
    }
    const initialAuthority = await readGitHubPublicationWorktreeOwner({
      allowExistingPullRequest: true,
      sessionId,
      sessionKey: input.sessionKey,
      agentId: input.agentId,
    });
    using _ = { [Symbol.dispose]: () => initialAuthority.release() };

    const loaded = initialAuthority.loaded;
    const lifecycleRevision = loaded.entry?.lifecycleRevision ?? null;
    const session = {
      sessionId,
      sessionKey: loaded.canonicalKey,
      agentId: input.agentId,
      lifecycleRevision,
    };
    const placement = await params.placements.getAsync(sessionId);
    assertRequester();
    const validateLocalExecution = () => {
      const current = params.placements.get(sessionId);
      return (!current || current.state === "local") && !current?.turnClaim;
    };
    const capturePlacement = placement
      ? {
          state: placement.state,
          generation: placement.generation,
          updatedAtMs: placement.updatedAtMs,
        }
      : null;
    const assertCaptureAuthority = () => {
      assertRequester();
      initialAuthority.assertCurrent();
      const current = params.placements.get(sessionId);
      const unchanged = capturePlacement
        ? current?.state === capturePlacement.state &&
          current.generation === capturePlacement.generation &&
          current.updatedAtMs === capturePlacement.updatedAtMs &&
          !current.turnClaim
        : current === undefined;
      if (!unchanged) {
        throw new Error("GitHub publication session authority changed during snapshot.");
      }
    };
    const claim = placement ? exactClaimForPlacement(placement) : undefined;
    if (claim && input.expectedRunId && claim.runId === input.expectedRunId) {
      const claimRequest = {
        expectedPublisher: expected,
        claim,
        sessionKey: loaded.canonicalKey,
        agentId: input.agentId,
        idempotencyKey: input.idempotencyKey,
        requester: input.requester,
        ...(input.title ? { title: input.title } : {}),
        ...(input.body ? { body: input.body } : {}),
        ...(input.draft !== undefined ? { draft: input.draft } : {}),
      };
      const accepted = await params.requestForClaimV2(claimRequest);
      assertRequester();
      if (placement?.state !== "local") {
        return accepted;
      }
      const row = await readGitHubPublicationRequestInWorker(accepted.requestId);
      if (!row) {
        throw new Error("GitHub publication request disappeared.");
      }
      return await processDuringRun(row, () => params.placements.validateTurnClaim(claim));
    }
    if (claim && placement?.state === "local") {
      throw new Error(
        input.expectedRunId
          ? "GitHub publication run identity changed."
          : "GitHub publication cannot join another active session turn.",
      );
    }
    const deferred = placement !== undefined && placement.state !== "local";
    const worktreeOwner = initialAuthority;
    const { worktree } = worktreeOwner;
    assertRequester();
    const existing = await readGitHubPublicationRequestAsync({
      sessionId,
      idempotencyKey: input.idempotencyKey,
    });
    const requestDigest = digestRequest({
      sessionId,
      idempotencyKey: input.idempotencyKey,
      title: input.title,
      body: input.body,
      draft:
        existing && existing.draft == null && input.draft === undefined
          ? undefined
          : (input.draft ?? false),
    });
    if (existing) {
      if (
        existing.request_digest !== requestDigest ||
        !sameWorktree(existing, worktree, worktreeOwner.publicationBranch)
      ) {
        throw new Error("GitHub publication idempotency key was reused.");
      }
      if (existing.status === "published" || existing.status === "failed") {
        const result = publicationResult(existing);
        assertExpectedSharedGitHubPublisher(expected, result.publisher!);
        return result;
      }
      const lifecycle = await readGitHubPublicationSessionLifecycleInWorker({
        publicationKind: "shared",
        requestId: existing.request_id,
      }).catch((cause: unknown) => {
        throw new GitHubPublicationRecoveryPendingError(
          "GitHub publication requester metadata is unavailable; retry the existing request.",
          { cause },
        );
      });
      input.requester.assertInvocationCurrent();
      if (!lifecycle || lifecycle.lifecycle_revision !== lifecycleRevision) {
        return await processDuringRun(existing, validateLocalExecution);
      }
    }
    assertRequester();
    const identity = await prepareCurrentGitHubPublicationIdentity(input.agentId);
    assertRequester();
    assertExpectedSharedGitHubPublisher(
      expected,
      { source: identity.source, ...identity.account },
      existing
        ? undefined
        : {
            idempotencyKey: input.idempotencyKey,
            hasRequest: () => Boolean(existing),
          },
    );
    const insertSessionRequest = async (snapshot?: {
      sourceHeadCommit: string;
      sourceIndexTree: string;
      workspaceTree: string;
    }): Promise<PublicationRow> => {
      const now = Date.now();
      const requestId = randomUUID();
      assertRequester();
      {
        worktreeOwner.assertCurrent();
        const source = await input.requester.prepareSource({
          agentId: session.agentId,
          sessionKey: session.sessionKey,
          sessionId,
          lifecycleRevision,
          worktreeId: worktree.id,
        });
        try {
          assertRequester();
          worktreeOwner.assertCurrent();
          if (snapshot) {
            assertCaptureAuthority();
          }
          bindGitHubPublicationSourceLifetime(source, params.signal);
          return await insertGitHubPublicationRequestAsync(
            {
              request: {
                sessionKey: loaded.canonicalKey,
                agentId: input.agentId,
                idempotencyKey: input.idempotencyKey,
                title: input.title,
                body: input.body,
                draft: input.draft ?? false,
              },
              requestId,
              requestDigest,
              now,
              identity: {
                source: identity.source,
                profileId: identity.profileId,
                account: identity.account,
              },
              worktree: {
                id: worktree.id,
                repoFingerprint: worktree.repoFingerprint,
                branch: worktreeOwner.publicationBranch,
              },
              sessionId,
              lifecycleRevision,
              requester: input.requester.snapshot,
              snapshot,
            },
            source,
          );
        } finally {
          await source.release();
        }
      }
    };
    if (deferred) {
      worktreeOwner.assertCurrent();
      return publicationResult(await insertSessionRequest());
    }
    const snapshot =
      existing?.source_head_commit && existing.source_index_tree && existing.workspace_tree
        ? {
            sourceHeadCommit: existing.source_head_commit,
            sourceIndexTree: existing.source_index_tree,
            workspaceTree: existing.workspace_tree,
          }
        : await captureGitHubPublicationWorkspaceSnapshot({
            cwd: worktree.path,
            assertCurrent: assertCaptureAuthority,
          });
    assertCaptureAuthority();
    const row = await insertSessionRequest(snapshot);
    return await processDuringRun(row, validateLocalExecution);
  };

  return {
    requestForSessionV2: (input: GitHubPublicationSessionRequestV2) => {
      if (!isGitHubPublicationRequesterV2(input.requester)) {
        throw new Error("GitHub publication requires a host-prepared V2 requester.");
      }
      params.assertCurrent();
      return requestForSession(input);
    },

    async resumeSessionRequests(isStopping?: () => boolean): Promise<void> {
      if (isStopping?.()) {
        return;
      }
      const rows = await listSharedGitHubPublicationsAsync({
        claimNull: true,
        pending: true,
      });
      params.assertCurrent();
      if (isStopping?.()) {
        return;
      }
      const pending = new Set(
        (await params.placements.listPendingWorkspaceResultsAsync()).map(
          (result) => result.sessionId,
        ),
      );
      const failures: Error[] = [];
      const blockedWorktrees = new Set<string>();
      if (isStopping?.()) {
        return;
      }
      const placements = await params.placements.getManyAsync(rows.map((row) => row.session_id));
      for (const row of rows) {
        if (isStopping?.()) {
          break;
        }
        if (
          blockedWorktrees.has(row.worktree_id) ||
          pending.has(row.session_id) ||
          placements.get(row.session_id)?.turnClaim
        ) {
          continue;
        }
        try {
          // An executing publication keeps its custody through durable settlement.
          await processRow(row, () => {
            const placement = params.placements.get(row.session_id);
            return !placement?.turnClaim && !pending.has(row.session_id);
          });
        } catch (error) {
          // Later requests for this checkout must not overtake its unfinished Git transaction.
          blockedWorktrees.add(row.worktree_id);
          failures.push(
            new Error(`Publication ${row.request_id}: ${formatErrorMessage(error)}`, {
              cause: error,
            }),
          );
        }
      }
      // A recoverable index transaction retains its receipt, not the entire queue.
      // Report failures after every independent request has had its turn.
      if (failures.length > 0) {
        throw new AggregateError(failures, failures.map((error) => error.message).join("; "));
      }
    },

    async processClaim(claim: WorkerSessionTurnClaim): Promise<SessionGitHubPublicationResult[]> {
      const rows = await listGitHubPublicationsForClaimAsync(claim);
      await deferGitHubPublicationRequestsAsync(
        { kind: "claimMissingSnapshot", claim },
        params.assertCurrent,
      );
      const results: SessionGitHubPublicationResult[] = [];
      for (const row of rows) {
        if (!row.source_head_commit || !row.source_index_tree || !row.workspace_tree) {
          continue;
        }
        await params.placements.prepareWorkspaceResultClaim(claim);
        results.push(
          await processRow(row, () => params.placements.validateWorkspaceResultClaim(claim)),
        );
      }
      const deferred = await listSharedGitHubPublicationsAsync({
        sessionId: claim.sessionId,
        claimNull: true,
        status: "requested",
      });
      for (const row of deferred) {
        await params.placements.prepareWorkspaceResultClaim(claim);
        results.push(
          await processRow(row, () => params.placements.validateWorkspaceResultClaim(claim)),
        );
      }
      return results;
    },

    async deferOrphanedRequestsAsync(): Promise<void> {
      await deferGitHubPublicationRequestsAsync({ kind: "orphaned" }, params.assertCurrent);
    },

    async listUnreportedResultsAsync() {
      const personal = await listUnreportedPersonalGitHubPublicationsAsync();
      const shared = await listSharedGitHubPublicationsAsync({
        pending: false,
        unreported: true,
      });
      params.assertCurrent();
      return [
        ...personal,
        ...shared.map((row) => ({
          sessionId: row.session_id,
          sessionKey: row.session_key,
          agentId: row.agent_id,
          result: publicationResult(row),
        })),
      ];
    },

    async sharedStatus(
      session: PublicationSessionIdentity,
      requestId: string,
      preparedRead?: Parameters<typeof readSharedGitHubPublication>[2],
    ): Promise<SessionGitHubStatusResult | undefined> {
      const row = await readSharedGitHubPublication(session, { requestId }, preparedRead);
      return row ? { result: publicationResult(row), confirmation: null } : undefined;
    },

    async latestPublishedShared(
      session: PublicationSessionIdentity,
      preparedRead?: Parameters<typeof readSharedGitHubPublication>[2],
    ): Promise<SessionGitHubStatusResult | null> {
      const row = await readSharedGitHubPublication(session, { status: "published" }, preparedRead);
      return row ? { result: publicationResult(row), confirmation: null } : null;
    },

    async latestShared(
      session: PublicationSessionIdentity,
      idempotencyKey?: string,
      isSuperseded?: (snapshot: {
        repository: string | null;
        branch: string;
        sourceHeadCommit: string | null;
        workspaceTree: string | null;
      }) => Promise<boolean>,
      preparedRead?: Parameters<typeof readSharedGitHubPublication>[2],
    ): Promise<SessionGitHubStatusResult | null> {
      const row = await readSharedGitHubPublication(session, { idempotencyKey }, preparedRead);
      // Discovery offers recovery for current work, not a failure whose accepted
      // snapshot has since been published. Exact-key and by-id history stay intact.
      if (
        row?.status === "failed" &&
        idempotencyKey === undefined &&
        isSuperseded &&
        (await isSuperseded({
          repository: row.repository,
          branch: row.branch,
          sourceHeadCommit: row.source_head_commit,
          workspaceTree: row.workspace_tree,
        }))
      ) {
        return null;
      }
      return row ? { result: publicationResult(row), confirmation: null } : null;
    },

    async readAsync(requestId: string): Promise<SessionGitHubPublicationResult | undefined> {
      const row = await readGitHubPublicationRequestAsync({
        requestId,
      });
      return row ? publicationResult(row) : undefined;
    },
  };
}

function sameClaim(row: PublicationRow, claim: WorkerSessionTurnClaim): boolean {
  return (
    row.claim_id === claim.claimId &&
    row.run_id === claim.runId &&
    row.placement_generation === claim.placementGeneration &&
    row.environment_id === (claim.owner.environmentId ?? null) &&
    row.owner_epoch === (claim.owner.ownerEpoch ?? null)
  );
}

export async function requestGitHubPublicationForClaim(
  params: {
    provider: RepositoryPublicationProvider;
    placements: WorkerSessionPlacementStore;
    assertCurrent: () => void;
    signal: AbortSignal;
  },
  request: GitHubPublicationClaimRequestV2,
): Promise<SessionGitHubPublicationResult> {
  const assertRequester = request.requester.assertCurrent;
  const placement = await params.placements.getAsync(request.claim.sessionId);
  assertRequester();
  if (!params.placements.validateTurnClaim(request.claim)) {
    throw new Error("GitHub publication lost the live session turn claim.");
  }
  if (
    !placement ||
    placement.sessionKey !== request.sessionKey ||
    placement.agentId !== request.agentId
  ) {
    throw new Error("GitHub publication session identity changed.");
  }
  using admitted = await readGitHubPublicationWorktreeOwner({
    allowExistingPullRequest: true,
    sessionId: request.claim.sessionId,
    sessionKey: request.sessionKey,
    agentId: request.agentId,
  });

  assertRequester();
  const identity = await prepareCurrentPublisher(params.provider, request.agentId);
  assertRequester();
  const existing = await readGitHubPublicationRequestAsync({
    sessionId: request.claim.sessionId,
    idempotencyKey: request.idempotencyKey,
  });
  assertRequester();
  assertExpectedSharedGitHubPublisher(
    request.expectedPublisher,
    { source: identity.source, ...identity.account },
    {
      idempotencyKey: request.idempotencyKey,
      hasRequest: () => Boolean(existing),
    },
  );
  const worktreeOwner = admitted;
  const { worktree } = worktreeOwner;
  if (!params.placements.validateTurnClaim(request.claim)) {
    throw new Error("GitHub publication lost the live session turn claim after verification.");
  }
  if (!matchesCurrentPublisher(identity)) {
    throw new Error("GitHub publication identity changed.");
  }
  const requestDigest = digestRequest({
    sessionId: request.claim.sessionId,
    idempotencyKey: request.idempotencyKey,
    title: request.title,
    body: request.body,
    draft:
      existing && existing.draft == null && request.draft === undefined
        ? undefined
        : (request.draft ?? false),
  });
  const now = Date.now();
  const requestId = randomUUID();
  const input = {
    request: {
      sessionKey: request.sessionKey,
      agentId: request.agentId,
      idempotencyKey: request.idempotencyKey,
      title: request.title,
      body: request.body,
      draft: request.draft ?? false,
    },
    requestId,
    requestDigest,
    now,
    identity: {
      source: identity.source,
      profileId: identity.profileId,
      account: identity.account,
    },
    worktree: {
      id: worktree.id,
      repoFingerprint: worktree.repoFingerprint,
      branch: worktreeOwner.publicationBranch,
    },
    sessionId: request.claim.sessionId,
    lifecycleRevision: admitted.loaded.entry?.lifecycleRevision ?? null,
    requester: request.requester.snapshot,
    claim: request.claim,
  };
  let row: PublicationRow;
  {
    const source = await request.requester.prepareSource({
      agentId: request.agentId,
      sessionKey: request.sessionKey,
      sessionId: request.claim.sessionId,
      lifecycleRevision: input.lifecycleRevision,
      worktreeId: worktree.id,
    });
    try {
      params.assertCurrent();
      assertRequester();
      worktreeOwner.assertCurrent();
      if (
        !params.placements.validateTurnClaim(request.claim) ||
        !matchesCurrentPublisher(identity)
      ) {
        throw new Error("GitHub publication authority changed before recording.");
      }
      bindGitHubPublicationSourceLifetime(source, params.signal);
      row = await insertGitHubPublicationRequestAsync(input, source);
    } finally {
      await source.release();
    }
  }
  if (!sameClaim(row, request.claim)) {
    throw new Error("GitHub publication idempotency key was reused.");
  }
  return publicationResult(row);
}
