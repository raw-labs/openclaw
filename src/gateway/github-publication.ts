import { randomUUID } from "node:crypto";
import type {
  SessionGitHubPublicationResult,
  SessionGitHubStatusResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import type { GitHubPublicationRow as PublicationRow } from "../state/github-publication-read.types.js";
import { createGitHubPublicationWorkerScope } from "../state/github-publication-worker.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createPersonalGitHubPublicationCoordinator } from "./github-personal-publication.js";
import {
  assertExpectedSharedGitHubPublisher,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  readGitHubPublicationWorktreeOwner,
  hasGitHubPublicationRepositoryWorkspace,
} from "./github-publication-availability.js";
import {
  createGitHubPublicationCoordinatorMethods,
  type GitHubPublicationClaimRequest,
  type GitHubPublicationClaimRequestV2,
  type GitHubPublicationSessionRequest,
} from "./github-publication-coordinator-methods.js";
import { executeGitHubPublication } from "./github-publication-executor.js";
import {
  digestGitHubPublicationRequest as digestRequest,
  projectGitHubPublicationResult as publicationResult,
} from "./github-publication-receipt.js";
import { reconcileGitHubPublication } from "./github-publication-recovery.js";
import { insertGitHubPublicationRequestAsync } from "./github-publication-request-async.js";
import { isGitHubPublicationRequesterV2 } from "./github-publication-requester.js";
import { bindGitHubPublicationSourceLifetime } from "./github-publication-source.js";
import {
  readGitHubPublicationRequestAsync,
  runGitHubPublicationMaintenanceAsync,
} from "./github-publication-store-async.js";
import { assertGitHubPublicationWorkflowChangesAllowed } from "./github-publication-workflows.js";
import {
  prepareGitHubPublicationClaimWorkspace,
  sameWorktree,
} from "./github-publication-workspace.js";
import { createRepositoryGitHubPublicationCoordinator } from "./github-repository-publication.js";
import { createRepositoryPublicationHostExecution } from "./repository-publication-host-execution.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

export type GitHubPublicationTranscriptReport = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  result: SessionGitHubPublicationResult;
  /** Run whose tool call requested this publication, when it is known to this process. */
  runId?: string;
};

function refuseLegacyPublication(
  method: string,
  replacement: string,
  guidance = "and await completion",
): never {
  warnPluginSdkDeprecation({
    family: "github-publication",
    compatibility: "This method no longer performs publication work; use its replacement.",
    method,
    replacement,
  });
  throw new Error(`Use ${replacement} ${guidance}.`);
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

export type GitHubPublicationCoordinator = ReturnType<typeof createGitHubPublicationCoordinator>;

export function createGitHubPublicationCoordinator(params: {
  placements: WorkerSessionPlacementStore;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  assertCurrent?: () => void;
  signal?: AbortSignal;
}) {
  const scope = createGitHubPublicationWorkerScope(captureOpenClawStateWorkerContext());
  const assertCurrent = params.assertCurrent ?? scope.assertCurrent;
  const signal = params.signal ?? scope.signal;

  const requestForClaim = async (
    request: GitHubPublicationClaimRequestV2,
  ): Promise<SessionGitHubPublicationResult> => {
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
    const identity = await prepareCurrentGitHubPublicationIdentity(request.agentId);
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
    if (!matchesCurrentGitHubPublicationIdentity({ agentId: request.agentId, identity })) {
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
        assertCurrent();
        assertRequester();
        worktreeOwner.assertCurrent();
        if (
          !params.placements.validateTurnClaim(request.claim) ||
          !matchesCurrentGitHubPublicationIdentity({ agentId: request.agentId, identity })
        ) {
          throw new Error("GitHub publication authority changed before recording.");
        }
        bindGitHubPublicationSourceLifetime(source, signal);
        row = await insertGitHubPublicationRequestAsync(input, source);
      } finally {
        await source.release();
      }
    }
    if (!sameClaim(row, request.claim)) {
      throw new Error("GitHub publication idempotency key was reused.");
    }
    return publicationResult(row);
  };

  const processRow = createRepositoryPublicationHostExecution({
    placements: params.placements,
    getCommittedRuntimeConfig: params.getCommittedRuntimeConfig,
    assertCurrent,
    signal,
    adapter: {
      execute: executeGitHubPublication,
      reconcile: reconcileGitHubPublication,
      assertWorkflowChangesAllowed: assertGitHubPublicationWorkflowChangesAllowed,
    },
  });

  const repository = createRepositoryGitHubPublicationCoordinator({
    ...params,
    assertCurrent,
    signal,
  });
  const personal = createPersonalGitHubPublicationCoordinator(
    params.placements,
    assertCurrent,
    signal,
  );
  // A publication processed inside its run's tool call reports into that run, so
  // the transcript notice stays within the turn. Process-local by design: after a
  // restart before reporting, the notice is recorded without a run, as it was before.
  const requestingRuns = new Map<string, string>();
  const methods = createGitHubPublicationCoordinatorMethods({
    placements: params.placements,
    assertCurrent,
    requestForClaimV2: requestForClaim,
    getCommittedRuntimeConfig: params.getCommittedRuntimeConfig,
    signal,
    sameWorktree,
    processRow,
    recordRequestingRun: (requestId, runId) => requestingRuns.set(requestId, runId),
  });
  return {
    ...methods,
    ...personal,
    /** @deprecated Use requestForClaimV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    requestForClaim: async (
      _request: GitHubPublicationClaimRequest,
    ): Promise<SessionGitHubPublicationResult> => {
      return refuseLegacyPublication(
        "requestForClaim",
        "requestForClaimV2",
        "with a host-prepared requester",
      );
    },
    requestForClaimV2: async (request: GitHubPublicationClaimRequestV2) => {
      if (!isGitHubPublicationRequesterV2(request.requester)) {
        throw new Error("GitHub publication requires a host-prepared V2 requester.");
      }
      assertCurrent();
      return (await hasGitHubPublicationRepositoryWorkspace({
        sessionId: request.claim.sessionId,
        sessionKey: request.sessionKey,
        agentId: request.agentId,
      }))
        ? repository.requestForClaimV2(request)
        : requestForClaim(request);
    },
    async prepareClaimWorkspace(claim: WorkerSessionTurnClaim) {
      await prepareGitHubPublicationClaimWorkspace(
        { placements: params.placements, assertCurrent },
        claim,
      );
      await repository.prepareClaimWorkspace(claim);
    },
    /** @deprecated Use deferClaimPreparationAsync; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    deferClaimPreparation(_claim: WorkerSessionTurnClaim): void {
      return refuseLegacyPublication("deferClaimPreparation", "deferClaimPreparationAsync");
    },
    async deferClaimPreparationAsync(claim: WorkerSessionTurnClaim) {
      await runGitHubPublicationMaintenanceAsync({ operation: "deferClaim", claim }, assertCurrent);
    },
    /** @deprecated Use requestForSessionV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    async requestForSession(
      _input: GitHubPublicationSessionRequest,
    ): Promise<SessionGitHubPublicationResult> {
      return refuseLegacyPublication(
        "requestForSession",
        "requestForSessionV2",
        "with a host-prepared requester",
      );
    },
    async requestForSessionV2(input: Parameters<typeof methods.requestForSessionV2>[0]) {
      if (!isGitHubPublicationRequesterV2(input.requester)) {
        throw new Error("GitHub publication requires a host-prepared V2 requester.");
      }
      assertCurrent();
      if (!input.sessionKey) {
        throw new Error("GitHub publication requires an authoritative session.");
      }
      const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
        cfg: params.getCommittedRuntimeConfig(),
        key: input.sessionKey,
        agentId: input.agentId,
        assertActive: assertCurrent,
      });
      return loaded.entry?.repositoryWorkspaceId
        ? repository.requestForSessionV2(input)
        : methods.requestForSessionV2(input);
    },
    /** @deprecated Use requestPersonalForSessionV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    async requestPersonalForSession(
      ..._args: Parameters<typeof personal.requestPersonalForSession>
    ): Promise<SessionGitHubPublicationResult> {
      return refuseLegacyPublication(
        "requestPersonalForSession",
        "requestPersonalForSessionV2",
        "with a host-prepared action",
      );
    },
    async requestPersonalForSessionV2(
      ...args: Parameters<typeof personal.requestPersonalForSessionV2>
    ) {
      return (await hasGitHubPublicationRepositoryWorkspace(args[1]))
        ? repository.requestPersonalForSessionV2(...args)
        : personal.requestPersonalForSessionV2(...args);
    },
    preparePersonalStatus: repository.preparePersonalStatus,
    /** @deprecated Use personalStatusAsync and await completion. */
    personalStatus(
      ..._args: Parameters<typeof repository.personalStatusAsync>
    ): SessionGitHubStatusResult {
      return refuseLegacyPublication("personalStatus", "personalStatusAsync");
    },
    async personalStatusAsync(...args: Parameters<typeof repository.personalStatusAsync>) {
      return (
        (await repository.personalStatusAsync(...args)) ??
        personal.personalStatusAsync(args[0], args[1], args[2])
      );
    },
    async personalPending(...args: Parameters<typeof personal.personalPending>) {
      return (await repository.personalPending(...args)) ?? personal.personalPending(...args);
    },
    /** @deprecated Use confirmPersonalV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    confirmPersonal(
      ..._args: Parameters<typeof personal.confirmPersonal>
    ): Promise<SessionGitHubPublicationResult> {
      return refuseLegacyPublication(
        "confirmPersonal",
        "confirmPersonalV2",
        "with a host-prepared action",
      );
    },
    async confirmPersonalV2(...args: Parameters<typeof personal.confirmPersonalV2>) {
      return (await repository.hasRequestAsync(args[0].requestId))
        ? repository.confirmPersonalV2(...args)
        : personal.confirmPersonalV2(...args);
    },
    async processClaim(claim: WorkerSessionTurnClaim) {
      return [...(await methods.processClaim(claim)), ...(await repository.processClaim(claim))];
    },
    async resumeSessionRequests(isStopping?: () => boolean) {
      const failures: unknown[] = [];
      for (const coordinator of [methods, repository]) {
        if (isStopping?.()) {
          break;
        }
        try {
          await coordinator.resumeSessionRequests(isStopping);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          failures
            .map((error) => (error instanceof Error ? error.message : String(error)))
            .join("; "),
        );
      }
    },
    /** @deprecated Use deferOrphanedRequestsAsync; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    deferOrphanedRequests(): void {
      return refuseLegacyPublication("deferOrphanedRequests", "deferOrphanedRequestsAsync");
    },
    async deferOrphanedRequestsAsync(): Promise<void> {
      await methods.deferOrphanedRequestsAsync();
      await repository.deferOrphanedRequestsAsync();
    },
    /** @deprecated Use listUnreportedResultsAsync; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    listUnreportedResults(): GitHubPublicationTranscriptReport[] {
      return refuseLegacyPublication("listUnreportedResults", "listUnreportedResultsAsync");
    },
    async listUnreportedResultsAsync() {
      const publications: GitHubPublicationTranscriptReport[] = [
        ...(await methods.listUnreportedResultsAsync()),
        ...(await repository.listUnreportedResultsAsync()),
      ];
      for (const publication of publications) {
        const runId = requestingRuns.get(publication.result.requestId);
        if (runId) {
          publication.runId = runId;
        }
      }
      return publications;
    },
    /** @deprecated Use readAsync and await completion. */
    read(_requestId: string): SessionGitHubPublicationResult | undefined {
      return refuseLegacyPublication("read", "readAsync");
    },
    async readAsync(requestId: string) {
      return (await repository.readAsync(requestId)) ?? methods.readAsync(requestId);
    },
    /** @deprecated Use markReportedAsync; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    markReported(_requestId: string): void {
      return refuseLegacyPublication("markReported", "markReportedAsync");
    },
    async markReportedAsync(requestId: string) {
      await runGitHubPublicationMaintenanceAsync({ operation: "report", requestId }, assertCurrent);
      requestingRuns.delete(requestId);
    },
  };
}
