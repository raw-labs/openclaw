import { readRepositoryServices } from "../../extensions/github-repositories/account-runtime-api.js";
import type { SessionGitHubActionParams } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { prepareGitCoauthorAttribution } from "../agents/git-coauthor-attribution.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { preparePublishingSession } from "./github-publication-action-target.js";
import { readGitHubPublicationEvidence } from "./github-publication-evidence.js";
import { prepareOwnGitHubPullRequestReader } from "./github-publication-inspect-reader.js";
import { prepareGitHubPublicationRequesterV2 } from "./github-publication-requester.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

type Options = Omit<GatewayRequestHandlerOptions, "params"> & {
  params: Exclude<
    SessionGitHubActionParams,
    { action: "refresh_base" | "inspect_pr" | "prepare_pr" }
  >;
};
/** Execute one explicit operation against the session's bound original PR or shared publication. */
export async function performSessionGitHubAction(options: Options): Promise<void> {
  const { params, context } = options;
  const caller = getGatewayToolCallerIdentity();
  if (
    caller &&
    (params.sessionKey !== caller.sessionKey ||
      (params.agentId && normalizeAgentId(params.agentId) !== normalizeAgentId(caller.agentId)))
  ) {
    throw new Error("GitHub action session does not match the current conversation.");
  }
  const edit = params.action === "edit" ? params : undefined;
  const evidenceUpload = params.action === "upload_evidence" ? params : undefined;
  const requestReview = params.action === "request_review";
  const ownPublicationAction = Boolean(edit || requestReview || evidenceUpload);
  const editsMetadata = edit && (edit.title !== undefined || edit.body !== undefined);
  if (
    edit &&
    ((edit.title !== undefined) !== (edit.expectedTitle !== undefined) ||
      (edit.body !== undefined) !== (edit.expectedBody !== undefined))
  ) {
    throw new Error(
      "Supply the observed expectedTitle or expectedBody for each field being edited.",
    );
  }
  if (params.action !== "inspect" && (!edit || editsMetadata) && !params.expectedHeadCommit) {
    throw new Error(
      "Read the current PR with edit or inspect, then supply its expectedHeadCommit and publication requestId when present.",
    );
  }
  if (params.action === "merge" && !params.mergeMethod) {
    throw new Error("Select the repository's intended mergeMethod before merging.");
  }
  const service = readRepositoryServices(context)?.publication;
  if (!service) {
    throw new Error("GitHub publication is unavailable on this Gateway.");
  }
  using resources = new DisposableStack();
  const target = await preparePublishingSession(
    { ...params, agentId: caller?.agentId ?? params.agentId },
    () => options.sessionMutationAuthorization?.assertCurrent(),
    resources,
  );
  const loaded = target.selected.readCurrent();
  const entry = loaded.entry!;
  const session = {
    sessionKey: loaded.canonicalKey,
    sessionId: entry.sessionId,
    agentId: loaded.agentId,
    lifecycleRevision: entry.lifecycleRevision ?? null,
  };
  const admitted = await prepareGitHubPublicationRequesterV2(options, session);
  resources.defer(admitted.release);
  const assertRequester = () => {
    if (readRepositoryServices(context)?.publication !== service) {
      throw new Error("The repository publisher stopped; inspect the current PR before retrying.");
    }
    target.assertCurrent();
    admitted.requester.assertCurrent();
    if (
      !ownPublicationAction &&
      !(params.action === "ready" && params.publishingSessionKey === undefined) &&
      !roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.write"],
        allowedScopes: admitted.requester.snapshot.scopes,
      })
    ) {
      throw new Error("GitHub pull request actions require full operator write permission.");
    }
  };
  assertRequester();
  const binding = entry.worktree?.githubPullRequest;
  const receipt = binding
    ? undefined
    : ownPublicationAction
      ? await service.latestPublishedShared(session, () => target.selected.readCurrent())
      : await service.latestShared(session, undefined, undefined, () =>
          target.selected.readCurrent(),
        );
  assertRequester();
  const publication = receipt?.result.status === "published" ? receipt.result : undefined;
  if (!binding && !publication) {
    throw new Error(
      edit
        ? "This session has no completed shared publication to edit."
        : "This session has no completed shared publication. For delegated work, select its publishingSessionKey explicitly.",
    );
  }
  if (binding && params.requestId) {
    throw new Error(
      "This PR is selected by its workspace association. Read it again and use expectedHeadCommit without a publication requestId.",
    );
  }
  if (
    publication &&
    ((params.action !== "inspect" && (!edit || editsMetadata) && !params.requestId) ||
      (params.requestId && params.requestId !== publication.requestId) ||
      (params.expectedHeadCommit && params.expectedHeadCommit !== publication.headCommit))
  ) {
    throw new Error(
      "The publication changed; inspect the current PR and review its head before retrying.",
    );
  }
  const pullRequest = binding
    ? { url: binding.url, repository: binding.base.repository, branch: binding.head.branch }
    : publication!;
  const fullWrite = roleScopesAllow({
    role: "operator",
    requestedScopes: ["operator.write"],
    allowedScopes: admitted.requester.snapshot.scopes,
  });
  const result = await service.performPullRequestAction({
    params,
    agentId: session.agentId,
    binding,
    publication,
    pullRequest,
    fullWrite,
    ...(binding && !fullWrite
      ? { reader: prepareOwnGitHubPullRequestReader(admitted.requester) }
      : {}),
    signal: admitted.requester.signal,
    assertCurrent: assertRequester,
    async assertPublicationCurrent() {
      assertRequester();
      if (!publication) {
        return;
      }
      const current = await service.latestPublishedShared(session, () =>
        target.selected.readCurrent(),
      );
      assertRequester();
      if (
        current?.result.status !== "published" ||
        current.result.requestId !== publication.requestId ||
        current.result.headCommit !== publication.headCommit ||
        current.result.url !== publication.url
      ) {
        throw new Error("The publication changed; read the current PR before uploading evidence.");
      }
    },
    async readEvidence() {
      assertRequester();
      if (!evidenceUpload) {
        throw new Error("This action did not select workspace evidence.");
      }
      return await readGitHubPublicationEvidence({
        evidence: evidenceUpload.evidence,
        sandbox: caller?.workspaceEvidenceSandbox,
        sessionKey: session.sessionKey,
        signal: admitted.requester.signal,
        assertCurrent: assertRequester,
      });
    },
    async prepareMergeAttribution(excludeAccountId) {
      assertRequester();
      const prepared = await prepareGitCoauthorAttribution({
        ...session,
        config: context.getRuntimeConfig(),
        storePath: loaded.storePath,
        excludeAccountId,
      });
      assertRequester();
      return prepared;
    },
  });
  assertRequester();
  options.respond(true, { ...result, publishingSessionKey: session.sessionKey });
}
