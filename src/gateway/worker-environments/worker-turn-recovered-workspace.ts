import type {
  RecoveredSessionPlacementTurn,
  SessionPlacementTurnParams,
} from "../../agents/session-placement-admission.js";
import {
  resolveSessionFilePathCore,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { WORKER_ADMISSION_DEADLINE_MS } from "../../worker/worker-connection-contract.js";
import { remoteExecSandboxRuntimeId } from "./placement-sandbox.js";
import {
  claimWorkerTurn,
  createRequiredWorkerTurnAdmission,
  releaseClaimIfOwned,
  waitForPendingWorkerResult,
} from "./worker-turn-admission.js";
import type { WorkerTurnLauncherOptions } from "./worker-turn-launcher.types.js";
import { isActiveRemoteExecPlacementForSession } from "./worker-turn-sandbox.js";
import { withWorkerTurnTranscriptDatabase } from "./worker-turn-transcript-target.js";
import { executeRemoteExecTurn } from "./workspace-result-finalize.js";

/** Reuse remote-exec admission and settlement for a continuation with no new user message. */
export async function runRecoveredWorkerWorkspaceTurn<T>(
  options: WorkerTurnLauncherOptions,
  params: RecoveredSessionPlacementTurn,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { target, runId } = params;
  const { sessionId, sessionKey, agentId, storePath } = target;
  return await withSessionTurn(
    { sessionId, sessionKey, agentId, storePath, abortSignal: params.signal },
    async (replyOperation, signal) => {
      const assertCurrent = () => {
        signal.throwIfAborted();
        params.assertCurrent();
      };
      const assertPlacement = (
        placement: Awaited<ReturnType<typeof options.placements.getAsync>>,
      ) => {
        assertCurrent();
        createRequiredWorkerTurnAdmission(options).assertCurrent(placement);
        if (
          !isActiveRemoteExecPlacementForSession(placement, target) ||
          remoteExecSandboxRuntimeId(placement) !== params.runtimeId
        ) {
          throw new Error("The original remote workspace is unavailable for recovery.");
        }
        return placement;
      };
      const facts = await options.placements.readProjection([sessionId], { current: true });
      let placement = assertPlacement(facts.placements.get(sessionId));
      await options.waitForAdmissionNode({
        placement,
        signal: AbortSignal.any([signal, AbortSignal.timeout(WORKER_ADMISSION_DEADLINE_MS)]),
        assertCurrent,
      });
      placement = assertPlacement(await options.placements.getAsync(sessionId));
      if (facts.pendingResults.has(sessionId)) {
        await options.reconcileActivePlacement(placement.environmentId);
        await waitForPendingWorkerResult({ placements: options.placements, sessionId, signal });
        placement = assertPlacement(await options.placements.getAsync(sessionId));
      }
      const identity = { sessionId, sessionKey, agentId };
      const admitted = await claimWorkerTurn({
        placements: options.placements,
        environments: options.environments,
        identity,
        placement,
        runId,
        assertCurrent,
        signal,
        isCancellationRequested: () => false,
      });
      if (!admitted) {
        throw new Error("The original worker placement did not admit recovery.");
      }
      const { turnClaim } = admitted;
      let handedOff = false;
      try {
        if (
          turnClaim.placementGeneration !== placement.generation ||
          !options.placements.validateTurnClaim(turnClaim)
        ) {
          throw new Error("The original worker placement changed during recovery.");
        }
        const workspace = await options.resolveWorkspace(identity);
        assertCurrent();
        const turn: SessionPlacementTurnParams = {
          ...identity,
          runId,
          workspaceDir: params.workspaceDir,
          sessionTarget: {
            ...identity,
            storePath,
            expectedLifecycleRevision: target.lifecycleRevision,
          },
          sessionFile: resolveSessionFilePathCore(
            sessionId,
            undefined,
            resolveSessionFilePathOptions({ agentId, storePath }),
          ),
          config: params.config,
          prompt: "",
          timeoutMs: (params.config.agents?.defaults?.timeoutSeconds ?? 600) * 1000,
          abortSignal: signal,
          suppressNextUserMessagePersistence: true,
          replyOperation,
        };
        const result = await withWorkerTurnTranscriptDatabase(
          turn,
          {
            assertCurrent,
            prepareAuthority: () => options.placements.prepareTurnClaimAuthority(turnClaim),
            signal,
          },
          async () => {
            const finished: { result?: { value: T } } = {};
            await executeRemoteExecTurn({
              environments: options.environments,
              onHandoff: () => {
                handedOff = true;
              },
              placement,
              placements: options.placements,
              workspaceOperations: options.workspaceOperations,
              workspace,
              turn,
              turnClaim,
              assertRunCurrent: assertCurrent,
              prepareAcceptedWorkspacePublication: options.prepareAcceptedWorkspacePublication,
              publishAcceptedWorkspace: options.publishAcceptedWorkspace,
              async runLocal() {
                finished.result = { value: await work(signal) };
                return { meta: { durationMs: 0 } };
              },
            });
            if (!finished.result) {
              throw new Error("The recovered workspace turn did not run.");
            }
            return finished.result.value;
          },
        );
        return result;
      } catch (error) {
        if (handedOff && options.placements.validateWorkspaceResultClaim(turnClaim)) {
          await options.placements.handoffWorkspaceResultRecovery(turnClaim);
        }
        throw error;
      } finally {
        if (!handedOff) {
          await releaseClaimIfOwned(options.placements, turnClaim);
        }
      }
    },
  );
}
