import { WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { AgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { registerConfigWriteListener } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  onUserProfilesChanged,
  onUserProfileEmailBindingChanged,
} from "../../state/user-profile-events.js";
import {
  parseWorkerGitHubLaunchBinding,
  type WorkerGitHubLaunchBinding,
} from "../../worker/launch-descriptor.js";
import {
  prepareGitHubPublicationWorkspaceOwner as prepareRepositoryPublicationWorkspace,
  type PublicationSessionIdentity as RepositoryPublicationSession,
} from "../github-publication-availability.js";
import { sameGitHubPublicationWorkspace as samePublicationWorkspace } from "../github-publication-policy.js";
import type {
  RepositoryPublicationProvider,
  RepositoryWorkerIdentity,
} from "../repository-publication-contract.js";
import { RepositoryWorkerIdentityTransfer } from "../repository-worker-identity-transfer.js";
import { StaleWorkerBuildError } from "./admission.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import {
  bindWorkerTurnGitHubGrant,
  type WorkerTurnExecutionIdentityStore,
} from "./placement-turn-claim-events.js";
import type {
  WorkerGitHubBindingGrant,
  WorkerGitHubBindingRefresh,
} from "./worker-github-binding-contract.js";

function workspaceKey(
  workspace: Awaited<ReturnType<typeof prepareRepositoryPublicationWorkspace>>["initial"],
) {
  return JSON.stringify(
    workspace.kind === "repository"
      ? [
          workspace.kind,
          workspace.workspace.workspaceId,
          workspace.workspace.url,
          workspace.workspace.branch,
        ]
      : [
          workspace.kind,
          workspace.worktree.id,
          workspace.worktree.repoFingerprint,
          workspace.worktree.branch,
        ],
  );
}

export type RepositoryWorkerPublicationFact = {
  available: boolean;
  identity?: RepositoryWorkerIdentity;
  workspaceKey?: string;
  branch?: string;
};

/** Core prepares source custody; the active vendor owns account discovery and credentials. */
export async function prepareRepositoryWorkerPublicationFact(
  params: RepositoryPublicationSession & {
    provider: RepositoryPublicationProvider;
    assertCurrent: () => void;
  },
): Promise<RepositoryWorkerPublicationFact | undefined> {
  try {
    params.assertCurrent();
    params.provider.assertCurrent();
    using workspace = await prepareRepositoryPublicationWorkspace(params, {
      assertCurrent: params.assertCurrent,
    });
    const initial = workspace.initial;
    const originUrl =
      initial.kind === "repository"
        ? initial.workspace.url
        : (await managedWorktrees.resolveRepositoryIdentity(initial.worktree.path)).originUrl;
    params.assertCurrent();
    const identity = await params.provider.prepareWorkerIdentity?.({
      agentId: params.agentId,
      originUrl,
      assertCurrent: params.assertCurrent,
    });
    const current = await workspace.read();
    params.assertCurrent();
    params.provider.assertCurrent();
    identity?.assertCurrent();
    if (!samePublicationWorkspace(initial, current)) {
      return undefined;
    }
    return {
      available: Boolean(identity),
      ...(identity
        ? {
            identity,
            workspaceKey: workspaceKey(initial),
            branch:
              initial.kind === "repository" ? initial.workspace.branch : initial.worktree.branch,
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}

const log = createSubsystemLogger("gateway/worker-github");

async function receiveIdentity(
  identity: RepositoryWorkerIdentity,
  branch: string,
  assertCurrent: () => void,
) {
  let received: { binding: WorkerGitHubLaunchBinding; expiresAtMs?: number } | undefined;
  await identity.deliver(
    new RepositoryWorkerIdentityTransfer(async (credential, assertIdentity) => {
      assertCurrent();
      assertIdentity();
      const { expiresAtMs, ...launchCredential } = credential;
      if (expiresAtMs !== undefined && expiresAtMs <= Date.now()) {
        throw new Error("Prepared credential expired; retry after background refresh.");
      }
      const binding = parseWorkerGitHubLaunchBinding({ ...launchCredential, branch });
      if (!binding) {
        throw new Error("Prepared worker identity is invalid.");
      }
      received = { binding, expiresAtMs };
    }),
  );
  assertCurrent();
  identity.assertCurrent();
  if (!received) {
    throw new Error("Worker identity transfer was not consumed.");
  }
  return received;
}

/** Admission binds cached account authority to the exact live turn and workspace. */
async function prepareWorkerGitHubBindingGrant(
  params: RepositoryPublicationSession & {
    identity: RepositoryWorkerIdentity;
    workspaceKey: string;
    branch: string;
    sessionTarget: AgentRunSessionTarget;
    signal: AbortSignal;
    assertCurrent: () => void;
  },
): Promise<WorkerGitHubBindingGrant> {
  const controller = new AbortController();
  const signal = AbortSignal.any([params.signal, params.identity.signal, controller.signal]);
  const assertRun = () => {
    signal.throwIfAborted();
    params.assertCurrent();
  };
  assertRun();
  params.identity.assertCurrent();
  const initialCredential = await receiveIdentity(params.identity, params.branch, assertRun);
  const workspace = await prepareRepositoryPublicationWorkspace(params, {
    sessionTarget: params.sessionTarget,
    assertCurrent: assertRun,
  });
  const initial = workspace.initial;
  const branch = initial.kind === "repository" ? initial.workspace.branch : initial.worktree.branch;
  if (
    workspaceKey(initial) !== params.workspaceKey ||
    branch !== initialCredential.binding.branch
  ) {
    workspace.release();
    throw new Error("Prepared publication workspace changed.");
  }
  let revision = 0;
  let preparedRevision = 0;
  let checkedAt = Date.now();
  let generation = 0;
  let pending: WorkerGitHubBindingRefresh | undefined;
  let currentToken = initialCredential.binding.token;
  let expiresAt = initialCredential.expiresAtMs;
  let pendingWork: Promise<WorkerGitHubBindingRefresh | undefined> | undefined;
  let released = false;
  const stops: (() => void)[] = [];
  const revoke = async () => {
    if (released) {
      return;
    }
    released = true;
    signal.removeEventListener("abort", onAbort);
    stops.splice(0).forEach((stop) => stop());
    workspace.release();
    controller.abort(new Error("Worker credential authority closed"));
  };
  const onAbort = () => {
    void revoke();
  };
  const assertCurrent = () => {
    try {
      assertRun();
      params.identity.assertCurrent();
      if (!samePublicationWorkspace(initial, workspace.current())) {
        throw new Error("Worker credential workspace authority changed.");
      }
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };
  const changed = () => {
    try {
      assertCurrent();
    } catch {
      /* Abort owns cleanup. */
    }
  };
  try {
    signal.addEventListener("abort", onAbort, { once: true });
    stops.push(
      registerConfigWriteListener(changed),
      onUserProfilesChanged(changed),
      onUserProfileEmailBindingChanged(changed),
      params.identity.subscribe((change) => {
        if (change === "retired") {
          controller.abort(new Error("Selected account profile removed"));
        } else {
          revision++;
        }
      }),
    );
    assertCurrent();
  } catch (error) {
    await revoke();
    throw error;
  }
  return {
    binding: initialCredential.binding,
    signal,
    assertCurrent,
    revoke,
    refresh(installedGeneration) {
      pendingWork ??= (async () => {
        assertCurrent();
        if (pending && installedGeneration === pending.generation) {
          currentToken = pending.token;
          expiresAt = pending.expiresAtMs;
          pending = undefined;
        }
        if (pending?.expiresAtMs !== undefined && pending.expiresAtMs <= Date.now()) {
          pending = undefined;
        }
        if (
          Date.now() - checkedAt < 60_000 &&
          revision === preparedRevision &&
          (expiresAt === undefined || expiresAt > Date.now() + 60_000)
        ) {
          return pending;
        }
        const startedRevision = revision;
        if ((await params.identity.refresh(assertCurrent)) === "retired") {
          controller.abort(new Error("Selected account changed; start a new turn"));
          signal.throwIfAborted();
        }
        const current = await workspace.read();
        assertCurrent();
        if (!samePublicationWorkspace(initial, current)) {
          controller.abort(new Error("Worker publication workspace changed"));
          signal.throwIfAborted();
        }
        const next = await receiveIdentity(params.identity, branch, assertCurrent);
        checkedAt = Date.now();
        preparedRevision = startedRevision;
        if (next.binding.token !== (pending?.token ?? currentToken)) {
          pending = {
            generation: ++generation,
            token: next.binding.token,
            expiresAtMs: next.expiresAtMs,
          };
        }
        return pending;
      })()
        .catch((error: unknown) => {
          assertCurrent();
          if (expiresAt !== undefined && expiresAt <= Date.now()) {
            controller.abort(error);
            signal.throwIfAborted();
          }
          log.warn(
            "Worker credential renewal failed; retrying while the current credential remains usable.",
          );
          return pending;
        })
        .finally(() => {
          pendingWork = undefined;
        });
      return pendingWork;
    },
  };
}

/** Attach a background fact to an admitted turn without running identity discovery. */
export async function bindWorkerGitHubTurn(params: {
  session: RepositoryPublicationSession;
  fact: RepositoryWorkerPublicationFact | undefined;
  sessionTarget: AgentRunSessionTarget;
  store: WorkerTurnExecutionIdentityStore;
  claim: WorkerSessionTurnClaim;
  protocolFeatures: readonly string[];
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<WorkerGitHubBindingGrant | undefined> {
  const { identity, workspaceKey: expectedWorkspace, branch } = params.fact ?? {};
  if (!identity || !expectedWorkspace || !branch) {
    return undefined;
  }
  if (!params.protocolFeatures.includes(WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE)) {
    throw new StaleWorkerBuildError();
  }
  const preparing = prepareWorkerGitHubBindingGrant({
    ...params.session,
    identity,
    workspaceKey: expectedWorkspace,
    branch,
    sessionTarget: params.sessionTarget,
    signal: params.signal,
    assertCurrent: params.assertCurrent,
  }).then((grant) => {
    if (params.signal.aborted) {
      void grant.revoke();
    }
    return grant;
  });
  const grant = await raceNodeWorkerOperation(preparing, params.signal);
  try {
    bindWorkerTurnGitHubGrant(params.store, params.claim, grant);
  } catch (error) {
    await grant.revoke();
    throw error;
  }
  return grant;
}
