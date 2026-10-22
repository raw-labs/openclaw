import { gitHubPublicApi } from "../../../extensions/github-repositories/public-api.js";
import { GitHubIdentityError } from "../../../extensions/github-repositories/tool-identity-api.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { capturePluginLifecycleAuthority } from "../../plugins/registry-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { prepareGitHubReaderIdentity } from "../github-reader-identity.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";

const handleGitHubRead: GatewayRequestHandler = async (options) => {
  const { params, respond, context, client, req } = options;
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
  const caller = client?.internal?.syntheticClient ? getGatewayToolCallerIdentity() : undefined;
  const assertCaller = caller && captureGatewayToolCallerAssertion();
  const assertToolAllowed = caller?.assertToolAllowed;
  const scope = getPluginRuntimeGatewayRequestScope();
  const registry = scope?.pluginRegistry;
  const record = registry?.plugins.find((plugin) => plugin.id === "github-repositories");
  const pluginCurrent =
    registry &&
    record &&
    capturePluginLifecycleAuthority(registry, record, { scopedRuntime: true });
  if (
    !caller ||
    !assertCaller ||
    !assertToolAllowed ||
    client?.internal?.pluginRuntimeOwnerId !== "github-repositories" ||
    !pluginCurrent
  ) {
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
  const signals = [options.signal, getAsyncWorkSignal(), ...(caller.approvalSignals ?? [])].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = AbortSignal.any(signals);
  const assertActive = () => {
    assertCaller();
    assertToolAllowed(toolName);
    options.sessionMutationCommitGuard?.();
    signal.throwIfAborted();
    if (!pluginCurrent() || options.hasCurrentClientAuthority?.() === false) {
      throw new Error("GitHub read authority is no longer active.");
    }
  };
  try {
    const { identity, assertSelected } = await prepareGitHubReaderIdentity(
      context,
      caller.agentId,
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

export const toolsGitHubHandlers: GatewayRequestHandlers = {
  "tools.github.read": handleGitHubRead,
  "tools.github.search": handleGitHubRead,
};
