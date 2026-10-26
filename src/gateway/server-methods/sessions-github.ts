import { readRepositoryServices } from "../../../extensions/github-repositories/account-runtime-api.js";
import { prepareCurrentGitHubPublicationOptionsIdentity } from "../../../extensions/github-repositories/publication-availability-api.js";
import { isGitHubPublicationSuperseded } from "../../../extensions/github-repositories/publication-relevance-api.js";
import { GitHubIdentityError } from "../../../extensions/github-repositories/read-identity-api.js";
import {
  ErrorCodes,
  type GatewayCoreRequestParams,
  errorShape,
  validateSessionGitHubPublishParams,
  validateSessionGitHubActionParams,
  validateSessionGitHubOptionsParams,
  validateSessionGitHubStatusParams,
  validateSessionGitHubConfirmParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionGitHubOptionsResult } from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { raceWithTimeout } from "../../../packages/retry/src/index.js";
import { canRefreshWorkspacePublicationBase } from "../../agents/sandbox/workspace-publication.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { OpenClawStateLeaseAcquisitionError } from "../../state/openclaw-state-lease-error.js";
import { performSessionGitHubAction } from "../github-publication-actions.js";
import { performSessionGitHubInspection } from "../github-publication-inspect.js";
import { prepareGitHubPublicationRequesterV2 } from "../github-publication-requester.js";
import { RepositoryPublicationFailureError } from "../repository-publication-engine-errors.js";
import {
  hasSupportedGitHubPublicationTarget,
  prepareRepositoryPublicationSession,
  type RepositoryPublicationSession,
} from "../repository-publication-workspace-authority.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { SessionWorkspaceReservationBusyError } from "../worker-environments/placement-workspace-reservation.kernel.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

type SessionGitHubMethod = Extract<keyof GatewayCoreRequestParams, `sessions.github.${string}`>;
const GITHUB_OPTIONS_TIMEOUT_MS = 5_000;
class GitHubOptionsTimeoutError extends Error {
  constructor() {
    super("GitHub publication options timed out after 5 seconds; retry the request.");
  }
}
const sessionGitHubFailureMessages = {
  "sessions.github.publish": "GitHub publication request failed",
  "sessions.github.action":
    "GitHub pull request action failed; inspect its current state before retrying.",
  "sessions.github.options": "GitHub publication options are unavailable.",
  "sessions.github.status": "GitHub publication status is unavailable.",
  "sessions.github.confirm": "GitHub publication confirmation failed.",
};

function publicationStateUnavailableError() {
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    "GitHub publication state is unavailable; retry after Gateway startup.",
  );
}

function defineSessionGitHubMethod<Method extends SessionGitHubMethod>(
  ...[method, validate, handler]: Parameters<typeof defineValidatedGatewayMethod<Method>>
) {
  return defineValidatedGatewayMethod(method, validate, async (options) => {
    const { agentId, sessionKey } = options.params;
    const key = sessionKey ?? getGatewayToolCallerIdentity()?.sessionKey;
    // Explicit public owners follow request admission, not private deleted-session remapping.
    if (agentId !== undefined && key) {
      const owner = resolveRequestedSessionAgentId(
        options.context.getRuntimeConfig(),
        key,
        agentId,
      );
      if (!owner.ok) {
        options.respond(false, undefined, owner.error);
        return;
      }
    }
    const publication = readRepositoryServices(options.context)?.publication;
    const respond = options.respond;
    // Request authority is bound to this exact options object, not its enumerable fields.
    options.respond = (...args) => {
      if (
        args[0] &&
        publication &&
        readRepositoryServices(options.context)?.publication !== publication
      ) {
        throw new Error("The repository publisher stopped; retry from the current service.");
      }
      respond(...args);
    };
    try {
      return await handler(options);
    } catch (error) {
      const publishing = method === "sessions.github.publish";
      if (publishing && error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      const acquisition =
        error instanceof OpenClawStateLeaseAcquisitionError ? error.outcome : undefined;
      const busy = error instanceof SessionWorkspaceReservationBusyError;
      const timedOut = error instanceof GitHubOptionsTimeoutError;
      const forbidden = acquisition
        ? acquisition.kind === "held"
        : !publishing && method !== "sessions.github.action" && !busy && !timedOut;
      options.respond(
        false,
        undefined,
        errorShape(
          forbidden ? ErrorCodes.FORBIDDEN : ErrorCodes.UNAVAILABLE,
          error instanceof Error ? error.message : sessionGitHubFailureMessages[method],
          acquisition
            ? {
                retryable: acquisition.kind === "store-unavailable",
                details: { leaseAcquisition: acquisition },
              }
            : busy || timedOut
              ? { retryable: true }
              : publishing &&
                  error instanceof RepositoryPublicationFailureError &&
                  "idempotencyKey" in options.params &&
                  error.rejection?.idempotencyKey === options.params.idempotencyKey
                ? { details: error.rejection }
                : undefined,
        ),
      );
    } finally {
      options.respond = respond;
    }
  });
}

async function isSessionPublicationSuperseded(
  options: Pick<GatewayRequestHandlerOptions, "client" | "context">,
  session: RepositoryPublicationSession,
  snapshot: Parameters<typeof isGitHubPublicationSuperseded>[0],
  assertCurrent: () => void,
): Promise<boolean> {
  const { client, context } = options;
  const prOwner = context.repositorySessions?.presentation;
  if (!client || !prOwner) {
    return false;
  }
  return await context.repositorySessions!.withRequestRead(
    {
      client,
      hasCurrentClientAuthority: () => {
        assertCurrent();
        return true;
      },
    },
    session,
    async (target) => {
      assertCurrent();
      if (!target) {
        return false;
      }
      const assertReadCurrent = () => {
        assertCurrent();
        target.assertCurrent();
      };
      const published = await prOwner.read(target, assertReadCurrent, "publication");
      assertReadCurrent();
      return published.status === "ready" && !published.rateLimited
        ? await isGitHubPublicationSuperseded(snapshot, published.pullRequests, {
            assertCurrent: assertReadCurrent,
          })
        : false;
    },
  );
}

export const sessionsGitHubHandlers: GatewayRequestHandlers = {
  "sessions.github.action": defineSessionGitHubMethod(
    "sessions.github.action",
    validateSessionGitHubActionParams,
    async (options) => {
      if (options.params.action === "prepare_pr") {
        const service = readRepositoryServices(options.context)?.publication;
        if (!service) {
          throw new Error("Repository publication service is unavailable.");
        }
        using selected = await prepareRepositoryPublicationSession(options.params.sessionKey, {
          agentId: getGatewayToolCallerIdentity()?.agentId ?? options.params.agentId,
          assertCurrent: () => options.sessionMutationAuthorization?.assertCurrent(),
        });
        const loaded = selected.readCurrent();
        const admitted = await prepareGitHubPublicationRequesterV2(options, {
          sessionKey: loaded.canonicalKey,
          agentId: loaded.agentId,
        });
        using requesterLifetime = { [Symbol.dispose]: admitted.release };
        void requesterLifetime;
        const result = await service.preparePullRequest({
          params: options.params,
          requester: admitted.requester,
          signal: options.signal,
        });
        admitted.requester.assertCurrent();
        options.respond(true, result);
        return;
      }
      if (options.params.action === "inspect_pr") {
        await performSessionGitHubInspection({ ...options, params: options.params });
        return;
      }
      if (options.params.action !== "refresh_base") {
        await performSessionGitHubAction({
          ...options,
          params: options.params,
        });
        return;
      }
      const caller = getGatewayToolCallerIdentity();
      const { params } = options;
      const sandbox = caller?.workspaceBaseRefreshSandbox;
      if (!canRefreshWorkspacePublicationBase(sandbox)) {
        throw new Error(
          "refresh_base needs this session's writable managed sandbox workspace. Sessions that run directly on the host merge the base with git in their workspace, then publish.",
        );
      }
      if (
        caller &&
        (params.sessionKey !== caller.sessionKey ||
          (params.agentId && normalizeAgentId(params.agentId) !== normalizeAgentId(caller.agentId)))
      ) {
        throw new Error("Base refresh must use the current conversation's workspace.");
      }
      using selected = await prepareRepositoryPublicationSession(params.sessionKey, {
        agentId: caller?.agentId ?? params.agentId,
        assertCurrent: () => options.sessionMutationAuthorization?.assertCurrent(),
      });
      const loaded = selected.readCurrent();
      if (!loaded.entry?.sessionId) {
        throw new Error("The base refresh session is unavailable.");
      }
      const session = {
        agentId: loaded.agentId,
        sessionKey: loaded.canonicalKey,
      };
      const admitted = await prepareGitHubPublicationRequesterV2(options, session);
      using _ = {
        [Symbol.dispose]: admitted.release,
      };
      const service = readRepositoryServices(options.context)?.publication;
      if (!service) {
        throw new Error("Repository publication service is unavailable.");
      }
      const result = await service.refreshBase({
        ...session,
        requester: admitted.requester,
        signal: options.signal,
        conflictsResolved: params.conflictsResolved,
        baseCommit: params.baseCommit,
      });
      selected.readCurrent();
      admitted.requester.assertCurrent();
      options.respond(true, result);
    },
  ),
  "sessions.github.publish": defineSessionGitHubMethod(
    "sessions.github.publish",
    validateSessionGitHubPublishParams,
    async (options) => {
      const { params, respond, context, sessionMutationAuthorization } = options;

      const coordinator = readRepositoryServices(context)?.publication;
      if (!coordinator) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "GitHub publication is unavailable on this Gateway"),
        );
        return;
      }
      const caller = getGatewayToolCallerIdentity();
      const sessionKey = caller?.sessionKey ?? params.sessionKey;
      if (
        !sessionKey ||
        (caller && params.sessionKey && params.sessionKey !== caller.sessionKey) ||
        (caller &&
          params.agentId &&
          normalizeAgentId(params.agentId) !== normalizeAgentId(caller.agentId))
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "GitHub publication session is invalid"),
        );
        return;
      }
      const agentId = caller?.agentId ?? params.agentId;
      if (params.selection?.source === "personal") {
        if (!params.sessionKey) {
          throw new Error("My GitHub publication requires an explicit session.");
        }
        const { preparePersonalGitHubSessionActionV2 } =
          await import("./github-personal-authorization.js");
        const admitted = await preparePersonalGitHubSessionActionV2(options, {
          sessionKey: params.sessionKey,
          agentId,
        });
        using _ = { [Symbol.dispose]: () => admitted.release() };

        const result = await coordinator.requestPersonalForSessionV2(params, admitted.action);
        admitted.action.assertCurrent();
        respond(true, result);

        return;
      }
      using selectedSession = await prepareRepositoryPublicationSession(sessionKey, {
        agentId,
        assertCurrent: () => sessionMutationAuthorization?.assertCurrent(),
      });
      const loaded = selectedSession.loaded;
      if (!loaded.entry?.sessionId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "GitHub publication session was not found"),
        );
        return;
      }
      sessionMutationAuthorization?.assertCurrent();
      const session = {
        sessionKey: loaded.canonicalKey,
        agentId: caller?.agentId ?? loaded.agentId,
      };
      const admitted = await prepareGitHubPublicationRequesterV2(options, session);
      using _ = { [Symbol.dispose]: () => admitted.release() };

      const result = await coordinator.requestForSessionV2({
        ...params,
        ...session,
        requester: admitted.requester,
        ...(caller?.operationalRunInstance?.runId
          ? { expectedRunId: caller.operationalRunInstance.runId }
          : {}),
      });
      sessionMutationAuthorization?.assertCurrent();
      respond(true, result);
    },
  ),
  "sessions.github.options": defineSessionGitHubMethod(
    "sessions.github.options",
    validateSessionGitHubOptionsParams,
    async (options) => {
      const deadline = new AbortController();
      await raceWithTimeout(
        async () => {
          const { prepareGitHubPublicationOptionsRead } =
            await import("./github-personal-authorization.js");
          using read = await prepareGitHubPublicationOptionsRead(
            options,
            options.params,
            deadline.signal,
          );

          const coordinator = readRepositoryServices(options.context)?.publication;
          if (!coordinator) {
            options.respond(false, undefined, publicationStateUnavailableError());
            return;
          }
          const service = readRepositoryServices(options.context)?.oauth?.personal;
          if (read.personal.kind === "eligible" && !service) {
            throw new Error("GitHub connections are unavailable; retry after Gateway startup.");
          }
          const action = read.personal.kind === "eligible" ? read.personal.action : null;
          const session = read.currentSession();
          const assertResponseCurrent = () => {
            if (readRepositoryServices(options.context)?.publication !== coordinator) {
              throw new Error("The repository publisher stopped; retry its current options.");
            }
            read.assertSessionUnchanged(session);
          };
          let sharedUnavailableReason: SessionGitHubOptionsResult["sharedUnavailableReason"];
          // Independent account and receipt owners can read concurrently. The response
          // still revalidates the same session and personal authority after all awaits.
          const [identity, personalSnapshot, pendingPersonal, latestShared] = await Promise.all([
            prepareCurrentGitHubPublicationOptionsIdentity(
              read.session.agentId,
              assertResponseCurrent,
            ).catch((error: unknown) => {
              sharedUnavailableReason =
                error instanceof GitHubIdentityError ? error.reason : "unverified";
              return null;
            }),
            action ? service!.status(action) : null,
            action ? coordinator.personalPending(action, session) : null,
            coordinator.latestShared(
              session,
              options.params.idempotencyKey,
              (snapshot) =>
                isSessionPublicationSuperseded(options, session, snapshot, assertResponseCurrent),
              read.currentSessionRead,
            ),
          ]);
          let shared: SessionGitHubOptionsResult["shared"] = identity
            ? {
                source: identity.source,
                accountId: identity.account.accountId,
                login: identity.account.login,
              }
            : null;
          if (shared && read.sessionScoped) {
            if (
              !(await hasSupportedGitHubPublicationTarget(
                session,
                assertResponseCurrent,
                read.currentSessionRead,
              ))
            ) {
              shared = null;
              sharedUnavailableReason = "unsupported_workspace";
            }
          }
          assertResponseCurrent();
          const personal =
            action && personalSnapshot
              ? service!.revalidateStatus(action, personalSnapshot)
              : personalSnapshot;
          options.respond(true, {
            personal,
            shared,
            ...(identity?.stale || personal?.stale ? { stale: true } : {}),
            ...(sharedUnavailableReason ? { sharedUnavailableReason } : {}),
            pendingPersonal,
            latestShared,
          });
        },
        GITHUB_OPTIONS_TIMEOUT_MS,
        () => {
          const error = new GitHubOptionsTimeoutError();
          // Revoke this read only; OAuth owns and settles any token rotation already started.
          deadline.abort(error);
          throw error;
        },
        { ref: false },
      );
    },
  ),
  "sessions.github.status": defineSessionGitHubMethod(
    "sessions.github.status",
    validateSessionGitHubStatusParams,
    async (options) => {
      const { prepareGitHubPublicationOptionsRead } =
        await import("./github-personal-authorization.js");
      using read = await prepareGitHubPublicationOptionsRead(options, options.params);

      const service = readRepositoryServices(options.context)?.publication;
      if (!service) {
        options.respond(false, undefined, publicationStateUnavailableError());
        return;
      }
      const prepared =
        read.personal.kind === "eligible"
          ? await service.preparePersonalStatus(options.params.requestId)
          : undefined;
      using _ = { [Symbol.dispose]: () => prepared?.release() };

      const session = read.currentSession();
      const shared = await service.sharedStatus(session, options.params.requestId);
      if (shared) {
        read.assertSessionUnchanged(session);
        options.respond(true, shared);
        return;
      }
      if (read.personal.kind !== "eligible") {
        throw new Error("GitHub publication was not found for this session and caller.");
      }
      const result = await service.personalStatusAsync(
        read.personal.action,
        session,
        options.params.requestId,
        prepared,
      );
      read.assertSessionUnchanged(session);
      options.respond(true, result);
    },
  ),
  "sessions.github.confirm": defineSessionGitHubMethod(
    "sessions.github.confirm",
    validateSessionGitHubConfirmParams,
    async (options) => {
      const service = readRepositoryServices(options.context)?.publication;
      if (!service) {
        throw new Error("GitHub publication is unavailable.");
      }
      const { preparePersonalGitHubSessionActionV2 } =
        await import("./github-personal-authorization.js");
      const admitted = await preparePersonalGitHubSessionActionV2(options, options.params);
      using _ = { [Symbol.dispose]: () => admitted.release() };

      const result = await service.confirmPersonalV2(options.params, admitted.action);
      admitted.action.assertCurrent();
      options.respond(true, result);
    },
  ),
};
