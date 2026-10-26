import { captureGatewayAgentToolInvocation } from "openclaw/plugin-sdk/gateway-method-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandler,
  type GatewayRequestHandlers,
} from "openclaw/plugin-sdk/gateway-runtime";
import { gitHubPublicApi } from "../public-api.js";
import { prepareGitHubReaderIdentity } from "../reader-identity-api.js";
import { GitHubIdentityError } from "../tool-identity-api.js";

const handleGitHubRead: GatewayRequestHandler = async (options) => {
  const { params, respond, context, req } = options;
  const searching = req.method === "tools.github.search";
  const toolName = searching ? "github_search" : "github_read";
  const operation = searching
    ? ({ type: "search", params: gitHubPublicApi.parseGitHubSearchParams(params) } as const)
    : ({ type: "read", params: gitHubPublicApi.parseGitHubReadTarget(params) } as const);
  if (
    !operation.params ||
    params.agentId !== undefined ||
    params.sessionKey !== undefined ||
    (params.refresh !== undefined && typeof params.refresh !== "boolean")
  ) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${req.method} params`),
    );
    return;
  }
  const invocation = await captureGatewayAgentToolInvocation(toolName, options);
  if (!invocation) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `GitHub reading requires an active ${toolName} tool invocation.`,
      ),
    );
    return;
  }
  const { signal, assertCurrent: assertActive } = invocation;
  try {
    const { identity, assertSelected } = await prepareGitHubReaderIdentity(
      context,
      invocation.agentId,
      assertActive,
    );
    const document =
      operation.type === "read"
        ? await gitHubPublicApi.loadGitHubDetail(
            operation.params,
            identity,
            undefined,
            params.refresh === true,
            { assertActive: assertSelected, signal },
          )
        : await gitHubPublicApi.searchPublicGitHubItems(operation.params, identity, undefined, {
            assertActive: assertSelected,
            signal,
          });
    assertSelected();
    respond(true, document, undefined);
  } catch (error) {
    const { message, ...details } =
      error instanceof GitHubIdentityError
        ? { message: error.message, retryable: error.reason !== "unavailable" }
        : gitHubPublicApi.formatControlUiGitHubPreviewError(error);
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message, details));
  }
};

export const toolsGitHubReadHandlers: GatewayRequestHandlers = {
  "tools.github.read": handleGitHubRead,
  "tools.github.search": handleGitHubRead,
};
