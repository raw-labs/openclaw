import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { captureRepositorySessionRequestRead } from "openclaw/plugin-sdk/repository-session-read";
import { repositorySessionPrTarget } from "./control-ui-session-pr-read-api.js";
import { gitHubCheckoutContext } from "./control-ui-session-prs-api.js";
import { resolveConfiguredGitHubApiBaseUrl, resolveConfiguredGitHubHost } from "./host-api.js";
import { prepareGatewayProjectGitHubIdentity } from "./project-identity-api.js";
import { gitHubPublicApi, type ControlUiGitHubSessionIdentity } from "./public-api.js";
import { resolveConfiguredGitHubToolIdentity } from "./tool-identity-api.js";

type Target = NonNullable<ReturnType<typeof gitHubPublicApi.parseGitHubTarget>>;

/** Private presentation borrows the current visible session's existing App reader. */
export async function withControlUiSessionGitHubRead<T>(
  options: GatewayRequestHandlerOptions,
  agentId: string,
  target: Target,
  run: (identity: ControlUiGitHubSessionIdentity) => Promise<T>,
  consume: (value: T) => void,
): Promise<T> {
  const { params, context } = options;
  const config = context.getRuntimeConfig();
  const host = resolveConfiguredGitHubHost(config);
  const apiBaseUrl = resolveConfiguredGitHubApiBaseUrl(config);
  const unavailable = () =>
    new gitHubPublicApi.ControlUiGitHubError(
      404,
      "GitHub link is outside the current session or unavailable to this reader",
    );
  if (
    typeof params.sessionKey !== "string" ||
    !params.sessionKey.trim() ||
    params.githubHost !== host ||
    host === "github.com"
  ) {
    throw unavailable();
  }
  const requestRead = await captureRepositorySessionRequestRead();
  const assertClient = () => {
    requestRead.assertCurrent();
    if (context.getRuntimeConfig() !== config) {
      throw unavailable();
    }
  };
  assertClient();
  return await requestRead.withRead(
    { sessionKey: params.sessionKey, agentId },
    async (prepared, request) => {
      if (!prepared) {
        throw unavailable();
      }
      const session = repositorySessionPrTarget(prepared, config, prepared);
      return await prepared.withSource(async (sourceScope) => {
        const assertCurrent = () => {
          assertClient();
          session.assertCurrent?.();
          sourceScope.assertCurrent();
        };
        assertCurrent();
        const repository =
          typeof session.source === "string"
            ? gitHubCheckoutContext((await sourceScope.readCheckoutFacts()) ?? null, host)
            : session.source;
        assertCurrent();
        if (
          !repository ||
          (repository.host ?? "github.com") !== host ||
          repository.owner.toLowerCase() !== target.owner.toLowerCase() ||
          repository.repo.toLowerCase() !== target.repo.toLowerCase()
        ) {
          throw unavailable();
        }
        const selected =
          resolveConfiguredGitHubToolIdentity({ config, agentId, scope: "agent" }) ??
          resolveConfiguredGitHubToolIdentity({ config, agentId, scope: "system" });
        const admitted =
          selected?.kind === "app-installation" &&
          selected.app.repositories.find(
            (entry) =>
              entry.fullName.toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase(),
          );
        if (!admitted) {
          throw unavailable();
        }
        const requestUrl = `https://${host}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/${target.kind === "pull" ? "pull" : target.kind === "issue" ? "issues" : "commit"}/${target.kind === "commit" ? target.sha : target.number}`;
        const identity = await prepareGatewayProjectGitHubIdentity({
          config,
          context,
          agentId,
          requestedRepository: `${repository.owner}/${repository.repo}`,
          assertActive: assertCurrent,
          withCredential: (run) => request.withCredential(requestUrl, run),
        });
        if (!identity?.token) {
          await identity?.revoke?.();
          throw unavailable();
        }
        let value: T;
        try {
          assertCurrent();
          const assertSelected = () => {
            assertCurrent();
            identity.assertSelected();
          };
          value = await run({
            ...identity,
            host,
            apiBaseUrl,
            signal: requestRead.signal,
            repository: { id: admitted.id, owner: repository.owner, repo: repository.repo },
            cacheScope: JSON.stringify([
              host,
              apiBaseUrl,
              admitted.id,
              requestRead.viewerIdentity,
              session.identity,
              identity.cacheScope,
            ]),
            assertSelected,
            revalidate: async () => {
              assertCurrent();
              await identity.revalidate();
              assertCurrent();
            },
          });
          assertSelected();
        } finally {
          await identity.revoke?.();
        }
        assertCurrent();
        identity.assertSelected();
        consume(value);
        return value;
      });
    },
  );
}
