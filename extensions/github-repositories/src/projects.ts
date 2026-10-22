import {
  GatewayErrorDetailCodes,
  validateProjectsAddParams,
  validateProjectsSearchRemoteParams,
} from "@openclaw/gateway-protocol";
import { isTrustedSecretSurfaceUnavailableError } from "openclaw/plugin-sdk/channel-secret-owner-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { defineValidatedGatewayHandler } from "openclaw/plugin-sdk/gateway-method-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlers,
} from "openclaw/plugin-sdk/gateway-runtime";
import { resolveConfiguredGitHubApiBaseUrl, resolveConfiguredGitHubHost } from "../host-api.js";
import { materializeProjectClone } from "../project-clone-api.js";
import { ProjectCloneError } from "../project-clone-runtime-api.js";
import { searchRemoteProjects } from "../project-search-api.js";
import { parseProjectGitUrl } from "../project-url-api.js";
import {
  CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE,
  gitHubPublicApi,
  githubApiToken,
} from "../public-api.js";
import { readCachedNativeGitHubToken } from "../read-identity-api.js";
export const repositoryProjectHandlers: GatewayRequestHandlers = {
  "projects.add": defineValidatedGatewayHandler(
    "projects.add",
    validateProjectsAddParams,
    async ({ params, respond, context, signal }) => {
      const cfg = context.getRuntimeConfig();
      respond(
        true,
        await materializeProjectClone(
          {
            gitUrl: params.gitUrl,
            name: params.name,
          },
          {
            signal,
            token: githubApiToken(process.env, cfg),
          },
        ),
        undefined,
      );
    },
    (error) => {
      const failure = isTrustedSecretSurfaceUnavailableError(error)
        ? {
            cause: "auth_required",
            message: CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE,
          }
        : error instanceof ProjectCloneError
          ? {
              cause: error.failure,
              message: error.message,
            }
          : undefined;
      return failure
        ? errorShape(
            failure.cause === "invalid_url" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
            failure.message,
            {
              details: {
                code: GatewayErrorDetailCodes.PROJECT_CLONE_FAILED,
                cause: failure.cause,
              },
              retryable: failure.cause === "network" || failure.cause === "clone_failed",
            },
          )
        : errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error));
    },
  ),
  "projects.searchRemote": defineValidatedGatewayHandler(
    "projects.searchRemote",
    validateProjectsSearchRemoteParams,
    async ({ params, respond, context, signal, hasCurrentClientAuthority }) => {
      const cfg = context.getRuntimeConfig();
      const host = resolveConfiguredGitHubHost(cfg);
      const apiBaseUrl = resolveConfiguredGitHubApiBaseUrl(cfg);
      const assertCurrent = () => {
        signal?.throwIfAborted();
        if (hasCurrentClientAuthority?.() === false) {
          throw new Error("Project requester authority changed during search");
        }
        if (context.getRuntimeConfig() !== cfg) {
          throw new gitHubPublicApi.ControlUiGitHubError(
            502,
            "GitHub host changed during project search",
          );
        }
      };
      assertCurrent();
      const nativeToken =
        cfg.gateway?.projects?.nativeGitHubSearch === true
          ? await readCachedNativeGitHubToken(process.env)
          : undefined;
      assertCurrent();
      const query = params.query.trim();
      const pastedUrl = /^(?:https?:|ssh:|git@)/iu.test(query);
      const parsedUrl = pastedUrl ? parseProjectGitUrl(query, host) : undefined;
      if (pastedUrl && !parsedUrl) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Enter a GitHub repository URL for this source."),
        );
        return;
      }
      const searchQuery = parsedUrl
        ? new URL(parsedUrl.url).pathname.slice(1).replace(/\.git$/u, "")
        : query;
      const result = await searchRemoteProjects(searchQuery, {
        assertCurrent,
        trackExecution: (run) => context.trackExecution(run),
        signal,
        host,
        apiBaseUrl,
        ...(cfg.gateway?.projects?.nativeGitHubSearch === true
          ? {
              token: nativeToken ?? "",
            }
          : {}),
      });
      assertCurrent();
      respond(true, result, undefined);
    },
    (error) => {
      const { message, ...details } =
        error instanceof gitHubPublicApi.ControlUiGitHubError ||
        isTrustedSecretSurfaceUnavailableError(error)
          ? gitHubPublicApi.formatControlUiGitHubPreviewError(error)
          : {
              message: "GitHub project search is unavailable. Retry shortly.",
              retryable: true,
            };
      return errorShape(ErrorCodes.UNAVAILABLE, message, details);
    },
  ),
};
