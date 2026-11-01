import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../../../../packages/agent-core/src/agent-loop.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { Model } from "../../../llm/types.js";
import * as providerRuntime from "../../../plugins/provider-runtime.js";
import { closeStateDatabaseForTest } from "../../../test-utils/database-cleanup.js";
import * as oauth from "../../auth-profiles/oauth.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../auth-profiles/runtime-snapshots.js";
import {
  loadAuthProfileStoreForRuntimeAsync,
  saveAuthProfileStore,
} from "../../auth-profiles/store-runtime.js";
import type { AuthProfileStore, OAuthCredential } from "../../auth-profiles/types.js";
import { resolveEmbeddedAgentStream } from "../stream-resolution.js";
import { createEmbeddedRunAuthController, type EmbeddedRunAuthState } from "./auth-controller.js";

const originalHost = getAiTransportHost();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  configureAiTransportHost(originalHost);
  clearRuntimeAuthProfileStoreSnapshots();
  await closeStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const profileId = "openai:fixture";
const credential: OAuthCredential = {
  type: "oauth",
  provider: "openai",
  authFlow: "chatgpt-token-sharing",
  issuer: "https://auth.example.test",
  clientId: "fixture-client",
  accountId: "fixture-account",
  access: "synthetic-captured",
  refresh: "synthetic-refresh",
  expires: Date.now() + 3_600_000,
};
function fixture() {
  const root = tempDirs.make("openclaw-request-renewal-");
  const agentDir = path.join(root, "agents/main/agent");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_AGENT_DIR", agentDir);
  const authStore: AuthProfileStore = { version: 1, profiles: { [profileId]: { ...credential } } };
  const save = (next?: OAuthCredential) =>
    saveAuthProfileStore({ version: 1, profiles: next ? { [profileId]: next } : {} }, agentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
  save(credential);
  const model = { provider: "openai", api: "openai-responses", id: "fixture" } as Model;
  const state: EmbeddedRunAuthState = {
    models: { runtime: model, effective: model },
    apiKeyInfo: {
      apiKey: credential.access,
      profileId,
      mode: "oauth",
      authFlow: credential.authFlow,
      source: "fixture",
    },
    lastProfileId: profileId,
    runtimeAuthState: null,
    runtimeAuthRefreshCancelled: false,
    profileIndex: 0,
    thinkLevel: "off",
  };
  const controller = createEmbeddedRunAuthController({
    config: {},
    agentDir,
    workspaceDir: root,
    authStore,
    authStorage: { setRuntimeApiKey() {} },
    profileCandidates: [profileId],
    initialThinkLevel: "off",
    attemptedThinking: new Set(),
    fallbackConfigured: false,
    allowTransientCooldownProbe: false,
    provider: "openai",
    modelId: "fixture",
    state,
    log: { debug() {}, info() {}, warn() {} },
  });
  const resolve = controller.createRequestApiKeyResolver();
  if (!resolve) {
    throw new Error("expected renewable request owner");
  }
  return { resolve, save, state, controller, agentDir };
}

describe("selected request credential owner", () => {
  it("finishes after a settled tool and server-side expiry without replaying its side effect", async () => {
    const { resolve, agentDir } = fixture();
    const model: Model = {
      id: "fixture-model",
      name: "Fixture",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8000,
      maxTokens: 1000,
    };
    const refreshed = {
      ...credential,
      access: "synthetic-renewed",
      refresh: "synthetic-rotated",
      expires: credential.expires + 1000,
    };
    const refresh = vi
      .spyOn(providerRuntime, "resolveProviderOAuthCredentialWithPlugin")
      .mockImplementation(async ({ credential: current, refresh: requested }) => {
        expect(requested).toBe(true);
        expect(current.accountId).toBe(credential.accountId);
        return { status: "available", credential: refreshed, apiKey: refreshed.access };
      });
    vi.spyOn(providerRuntime, "resolveProviderOAuthRefreshCapabilityWithPlugin").mockReturnValue({
      status: "available",
    });
    const requests: ResponseCreateParamsStreaming[] = [];
    const bearers: Array<string | null> = [];
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "side effect committed once" }],
      details: {},
    }));
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetch: () => async (_input, init) => {
        const body = init?.body;
        if (!(body instanceof Uint8Array)) {
          throw new Error("Expected encoded Responses request");
        }
        requests.push(JSON.parse(new TextDecoder().decode(body)) as ResponseCreateParamsStreaming);
        bearers.push(new Headers(init?.headers).get("authorization"));
        if (requests.length === 2) {
          expect(execute).toHaveBeenCalledOnce();
          return new Response(
            JSON.stringify({ error: { code: "token_expired", message: "expired after tool" } }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        const output =
          requests.length === 1
            ? [
                {
                  type: "function_call",
                  id: "fc_commit",
                  call_id: "call_commit",
                  name: "commit",
                  arguments: "{}",
                  status: "completed",
                },
              ]
            : [
                {
                  type: "message",
                  id: "msg_final",
                  role: "assistant",
                  status: "completed",
                  content: [
                    { type: "output_text", text: "Completed successfully.", annotations: [] },
                  ],
                },
              ];
        const response = {
          id: "resp_" + requests.length,
          object: "response",
          status: "completed",
          model: model.id,
          output,
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        };
        return new Response(
          "data: " +
            JSON.stringify({ type: "response.completed", response }) +
            "\n\ndata: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const { streamFn } = resolveEmbeddedAgentStream({
      llmRuntime: defaultLlmRuntime,
      currentStreamFn: undefined,
      model,
      sessionId: "successful-renewal",
      resolvedApiKey: "synthetic-captured",
      resolveRequestApiKey: resolve,
    });
    const result = await runAgentLoop(
      [{ role: "user", content: "Commit once, then report.", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [
          {
            name: "commit",
            label: "Commit",
            description: "Commit a side effect",
            parameters: Type.Object({}),
            execute,
          },
        ],
      },
      {
        model,
        convertToLlm: (messages) =>
          messages.filter(
            (message) =>
              message.role === "user" ||
              message.role === "assistant" ||
              message.role === "toolResult",
          ),
      },
      () => {},
      undefined,
      (selectedModel, context, options) =>
        streamFn(selectedModel, context, { ...options, transport: "sse" }),
    );
    expect(result.at(-1), JSON.stringify(result.at(-1))).toMatchObject({
      role: "assistant",
      stopReason: "stop",
      content: [expect.objectContaining({ type: "text", text: "Completed successfully." })],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(3);
    expect(requests[1]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_commit",
          output: "side effect committed once",
        }),
      ]),
    );
    expect(requests[2]?.input).toEqual(requests[1]?.input);
    expect(bearers).toEqual([
      "Bearer synthetic-captured",
      "Bearer synthetic-captured",
      "Bearer synthetic-renewed",
    ]);
    expect(
      (await loadAuthProfileStoreForRuntimeAsync(agentDir, { externalCli: { mode: "none" } }))
        .profiles[profileId],
    ).toMatchObject({ access: refreshed.access, refresh: refreshed.refresh });
  });
  it.each(["remove", "rotate", "cancel"])(
    "rejects late credential resolution after %s",
    async (change) => {
      const { resolve, save, state } = fixture();
      const entered = createDeferred();
      const released = createDeferred();
      const resolveProfile = oauth.resolveApiKeyForProfile;
      vi.spyOn(oauth, "resolveApiKeyForProfile").mockImplementation(async (params) => {
        const resolved = await resolveProfile(params);
        entered.resolve();
        await released.promise;
        return resolved;
      });
      const abort = new AbortController();
      const result = resolve({ forceRefresh: false, signal: abort.signal });
      const rejection = expect(result).rejects.toThrow();
      await entered.promise;
      if (change === "remove") {
        save();
      } else if (change === "rotate") {
        state.profileIndex++;
      } else {
        abort.abort(new Error("fixture canceled"));
      }
      released.resolve();
      await rejection;
    },
  );
  it("reads a canonical replacement instead of the still-usable prepared credential, then refuses removal", async () => {
    const { resolve, save } = fixture();
    save({ ...credential, access: "synthetic-current", expires: credential.expires + 1000 });
    await expect(resolve({ forceRefresh: false })).resolves.toBe("synthetic-current");
    save();
    await expect(resolve({ forceRefresh: false })).rejects.toThrow("unavailable");
  });
  it("refuses another account under the selected profile id", async () => {
    const { resolve, save } = fixture();
    save({ ...credential, accountId: "other-account" });
    await expect(resolve({ forceRefresh: false })).rejects.toThrow("different account");
  });
  it("fences a retained resolver after selection rotation and cancellation", async () => {
    const { resolve, state } = fixture();
    state.profileIndex++;
    await expect(resolve({ forceRefresh: false })).rejects.toThrow("no longer current");
    const abort = new AbortController();
    abort.abort(new Error("fixture canceled"));
    await expect(resolve({ forceRefresh: true, signal: abort.signal })).rejects.toThrow(
      "fixture canceled",
    );
  });
  it("does not install renewal for static or runtime-exchanged credentials", () => {
    const { state, controller } = fixture();
    state.apiKeyInfo = { apiKey: "synthetic-static", source: "fixture", mode: "token", profileId };
    expect(controller.createRequestApiKeyResolver()).toBeUndefined();
    state.apiKeyInfo = {
      apiKey: "synthetic-oauth",
      source: "fixture",
      mode: "oauth",
      authFlow: credential.authFlow,
      profileId,
    };
    state.runtimeAuthState = {
      generation: 1,
      sourceApiKey: "synthetic-source",
      authMode: "oauth",
      profileId,
    };
    expect(controller.createRequestApiKeyResolver()).toBeUndefined();
  });
});
