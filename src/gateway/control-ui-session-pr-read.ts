import { isDeepStrictEqual } from "node:util";
import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { readUserProfileAliasRevision } from "../state/user-profile-events.js";
import { readResidentUserProfileId } from "../state/user-profile-list.js";
import {
  observeSelectedRepositorySession,
  prepareSelectedRepositorySessionRead,
} from "./control-ui-session-pr-source.js";
import type { createRepositoryTaskPublicationReader } from "./control-ui-session-task-prs.js";
import { withRepositoryTaskAudience } from "./control-ui-session-task-prs.js";
import { captureOwnGitHubPullRequestReader } from "./github-publication-inspect-reader.js";
import { hasCurrentGatewayOperatorAccess } from "./operator-access-policy.js";
import {
  authorizeCurrentOperatorRoleScopes,
  resolveGatewayOperatorRoleActor,
} from "./operator-role-policy.js";
import { READ_SCOPE, SESSION_READ_SCOPE } from "./operator-scopes.js";
import type { PreparedRepositorySessionRead } from "./repository-session-read.types.js";
import { isGatewayClientProfilePending } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { isSessionCreatorProfile } from "./session-creator.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { createSessionListEntryFilter } from "./session-sharing.js";
import { retainGatewaySessionEntryReadOnly } from "./session-utils-read-lifetime.js";

/** Retain the existing viewer access policy; never derive authority from cached observations. */
export function createRepositoryViewerRead(params: {
  allowOwnImportedPullRequest?: boolean;
  client: GatewayClient;
  sessionKey: string;
  agentId?: string;
  getRuntimeConfig: () => OpenClawConfig;
  getSessionRowProjection: () => SessionRowProjection | undefined;
  isCurrentClient: () => boolean;
  lifetime: AbortSignal;
  runSource: <T>(run: () => Promise<T>) => Promise<T>;
  readTaskReceipts: ReturnType<typeof createRepositoryTaskPublicationReader>;
}): (() => Promise<PreparedRepositorySessionRead | undefined>) | undefined {
  const {
    client,
    sessionKey,
    agentId,
    getRuntimeConfig,
    getSessionRowProjection,
    isCurrentClient,
  } = params;
  const actor = resolveGatewayOperatorRoleActor(client);
  const actorKind = actor?.kind;
  const actorProfile = actor?.kind === "operator" ? actor.profileId : undefined;
  const profileInput = client.authenticatedUserProfile?.profileId;
  const userInput = client.authenticatedUserId;
  const scopes = [...(client.connect.scopes ?? [])].toSorted().join("\0");
  const access = client.internal?.operatorAccessAuthority;
  const connectionSignal = client.connectionSignal;
  const projection = getSessionRowProjection();
  if (!projection) {
    return undefined;
  }
  let aliasRevision = -1;
  const captureCurrent = () => {
    try {
      params.lifetime.throwIfAborted();
      const currentActor = resolveGatewayOperatorRoleActor(client);
      if (
        !isCurrentClient() ||
        client.invalidated ||
        (client.connect.role ?? "operator") !== "operator" ||
        client.connectionSignal !== connectionSignal ||
        connectionSignal?.aborted ||
        isGatewayClientProfilePending(client) ||
        client.authenticatedUserProfile?.profileId !== profileInput ||
        client.authenticatedUserId !== userInput ||
        currentActor?.kind !== actorKind ||
        (currentActor?.kind === "operator" ? currentActor.profileId : undefined) !== actorProfile ||
        [...(client.connect.scopes ?? [])].toSorted().join("\0") !== scopes ||
        client.internal?.operatorAccessAuthority !== access ||
        !hasCurrentGatewayOperatorAccess(access)
      ) {
        return undefined;
      }
      const currentAliasRevision = readUserProfileAliasRevision();
      if (currentAliasRevision !== aliasRevision) {
        if (actorProfile && readResidentUserProfileId(actorProfile) !== actorProfile) {
          return undefined;
        }
        aliasRevision = currentAliasRevision;
      }
      const cfg = getRuntimeConfig();
      if (
        authorizeCurrentOperatorRoleScopes(client, cfg) ||
        !roleScopesAllow({
          role: "operator",
          requestedScopes: [params.allowOwnImportedPullRequest ? SESSION_READ_SCOPE : READ_SCOPE],
          allowedScopes: client.connect.scopes ?? [],
        })
      ) {
        return undefined;
      }
      const requested = resolveRequestedSessionAgentId(cfg, sessionKey, agentId);
      if (!requested.ok) {
        return undefined;
      }
      if (getSessionRowProjection() !== projection) {
        return undefined;
      }
      const query = { key: sessionKey, agentId: requested.agentId };
      const selected = projection.capture(query);
      // Exact reads prepare this session; unrelated pending membership must not hide it.
      if (
        !selected?.entry ||
        !projection.isCurrent(selected) ||
        (isIncognitoSessionKey(selected.key)
          ? projection.needsMembershipPreparation()
          : projection.sharingTargetState(query).status !== "ready") ||
        createSessionListEntryFilter({ cfg, client })?.(selected.key, selected.entry) === false
      ) {
        return undefined;
      }
      return { cfg, query, selected };
    } catch {
      return undefined;
    }
  };
  return async () => {
    try {
      params.lifetime.throwIfAborted();
      if (getSessionRowProjection() !== projection) {
        return undefined;
      }
      return await withReadySessionRows(
        projection,
        (cfg) => {
          const requested = resolveRequestedSessionAgentId(cfg, sessionKey, agentId);
          return requested.ok ? [{ key: sessionKey, agentId: requested.agentId }] : [];
        },
        (read) => {
          const captured = captureCurrent();
          if (!captured) {
            return undefined;
          }
          const record = read.describe(captured.query, captured.selected);
          const storePath = record?.storeTarget.storePath;
          if (!record || !storePath) {
            return undefined;
          }
          const sessionOnly = !roleScopesAllow({
            role: "operator",
            requestedScopes: [READ_SCOPE],
            allowedScopes: client.connect.scopes ?? [],
          });
          const repository = record.materialized.row.repository ?? null;
          const selected = {
            cfg: captured.cfg,
            agentId: record.agentId,
            canonicalKey: record.key,
            storePath,
            readSource: { agentId: record.storeTarget.agentId, path: storePath },
            entry: record.entry,
          };
          const observation = observeSelectedRepositorySession(selected, repository);
          if (!observation) {
            return undefined;
          }
          const privateRow = isIncognitoSessionKey(captured.selected.key);
          const rowContext = projection.readPreparedRowContext();
          if (privateRow && captured.selected.entry?.repositoryWorkspaceId && !rowContext) {
            return undefined;
          }
          const original = privateRow
            ? {
                generation: captured.selected.generation,
                sessionId: captured.selected.entry?.sessionId,
                lifecycleRevision: captured.selected.entry?.lifecycleRevision,
                rowContext,
              }
            : undefined;
          const assertCurrent = () => {
            params.lifetime.throwIfAborted();
            const current = captureCurrent();
            if (!current) {
              throw new Error("Session repository target changed");
            }
            if (!original) {
              if (current.selected !== captured.selected) {
                throw new Error("Session repository target changed");
              }
              return;
            }
            const row = current.selected;
            if (
              row.generation !== original.generation ||
              row.entry?.sessionId !== original.sessionId ||
              row.entry?.lifecycleRevision !== original.lifecycleRevision ||
              (row.entry?.repositoryWorkspaceId &&
                (!original.rowContext ||
                  projection.readPreparedRowContext() !== original.rowContext)) ||
              observeSelectedRepositorySession(
                {
                  cfg: current.cfg,
                  agentId: row.agentId,
                  canonicalKey: row.key,
                  storePath: row.storeTarget.storePath,
                  readSource: { agentId: row.storeTarget.agentId, path: row.storeTarget.storePath },
                  entry: row.entry,
                },
                repository,
              )?.identity !== observation.identity
            ) {
              throw new Error("Session repository target changed");
            }
          };
          const target = prepareSelectedRepositorySessionRead(selected, repository, {
            assertCurrent,
            runSource: params.runSource,
          });
          if (!target) {
            return undefined;
          }
          if (sessionOnly) {
            const binding = record.entry.worktree?.githubPullRequest;
            if (
              !actorProfile ||
              !binding?.preparedHeadCommit ||
              !isSessionCreatorProfile(record.entry.createdActor, actorProfile)
            ) {
              return undefined;
            }
            const ownReader = captureOwnGitHubPullRequestReader(actorProfile, () =>
              resolveConfiguredGitHubHost(getRuntimeConfig()),
            );
            return {
              ...target,
              boundPullRequest: binding,
              viewerProfileId: actorProfile,
              ownGitHubIdentity: ownReader.identity,
              assertCurrent() {
                target.assertCurrent();
                ownReader.assertCurrent();
              },
              async inspectBoundPullRequest() {
                const { readOwnGitHubPullRequest } =
                  await import("./github-publication-pr-inspect.js");
                return await readOwnGitHubPullRequest({
                  pullRequestUrl: binding.url,
                  agentId: target.session.agentId,
                  reader: ownReader,
                  assertCurrent: target.assertCurrent,
                });
              },
            };
          }
          return withRepositoryTaskAudience(
            params.allowOwnImportedPullRequest
              ? { ...target, boundPullRequest: record.entry.worktree?.githubPullRequest }
              : target,
            projection,
            record,
            () => {
              const filter = createSessionListEntryFilter({ cfg: getRuntimeConfig(), client });
              return (row) => filter?.(row.key, row.entry) !== false;
            },
            params.readTaskReceipts,
            actorProfile,
          );
        },
      );
    } catch {
      return undefined;
    }
  };
}

/** Internal CI reads retain their existing visibility policy and exact durable/memory selection. */
export async function withRepositoryInternalSessionRead<T>(
  params: {
    getConfig: () => OpenClawConfig;
    query: { sessionKey: string; agentId?: string };
    assertCurrent: () => void;
  },
  consume: (read: PreparedRepositorySessionRead | undefined) => Promise<T>,
): Promise<T> {
  params.assertCurrent();
  const cfg = params.getConfig();
  const requested = resolveRequestedSessionAgentId(
    cfg,
    params.query.sessionKey,
    params.query.agentId,
  );
  if (!requested.ok) {
    return consume(undefined);
  }
  const fields = [
    "repositoryWorkspaceId",
    "worktree",
    "spawnedCwd",
    "spawnedWorkspaceDir",
    "pendingWorktree",
    "pendingProjectGitUrl",
    "deviceFolder",
  ] as const;
  const selected = await retainGatewaySessionEntryReadOnly(
    params.query.sessionKey,
    requested.agentId,
    (previous, current) =>
      fields.every((field) => isDeepStrictEqual(previous[field], current[field])),
    cfg,
    { exactRead: true },
  );
  try {
    params.assertCurrent();
    const entry = selected.entry;
    if (!entry?.sessionId) {
      return await consume(undefined);
    }
    const workspaceId = entry.repositoryWorkspaceId;
    const workspace = workspaceId
      ? await getSessionRepositoryWorkspaceStore().prepare(workspaceId)
      : undefined;
    const current = () => {
      params.assertCurrent();
      const currentConfig = params.getConfig();
      if (
        !selected.isCurrentAtResponse() ||
        createSessionListEntryFilter({ cfg: currentConfig, client: null })?.(
          selected.canonicalKey,
          entry,
        ) === false
      ) {
        return undefined;
      }
      const repository = workspace?.current();
      return {
        cfg: currentConfig,
        repository:
          repository?.workspaceId === workspaceId &&
          repository?.agentId === selected.agentId &&
          repository.sessionKey === selected.canonicalKey
            ? repository
            : null,
      };
    };
    const captured = current();
    if (!captured) {
      return await consume(undefined);
    }
    const observation = observeSelectedRepositorySession(
      { ...selected, cfg: captured.cfg },
      captured.repository,
    );
    if (!observation) {
      return await consume(undefined);
    }
    const assertCurrent = () => {
      const facts = current();
      if (
        !facts ||
        observeSelectedRepositorySession({ ...selected, cfg: facts.cfg }, facts.repository)
          ?.identity !== observation.identity
      ) {
        throw new Error("Repository session target changed");
      }
    };
    const read = prepareSelectedRepositorySessionRead(
      { ...selected, cfg: captured.cfg },
      captured.repository,
      { assertCurrent, runSource: (run) => run() },
    );
    return await consume(read);
  } finally {
    selected.release();
  }
}
