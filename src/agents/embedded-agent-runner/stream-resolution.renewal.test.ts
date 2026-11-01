import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../../../packages/ai/src/host.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AssistantMessage, Model } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import type { StreamFn } from "../runtime/index.js";
import { resolveEmbeddedAgentStream, selectEmbeddedAgentStream } from "./stream-resolution.js";

const originalHost = getAiTransportHost();
afterEach(() => configureAiTransportHost(originalHost));

const model = { id: "fixture-model", provider: "openai", api: "openai-responses" } as Model;
const done: AssistantMessage = {
  role: "assistant",
  content: [],
  api: "openai-responses",
  provider: "openai",
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
};

describe("embedded request credential renewal", () => {
  it.each([
    { status: 401, code: "invalid_api_key", output: false },
    { status: 403, code: "token_expired", output: false },
    { status: 401, code: "token_expired", output: true },
  ])("does not retry $status/$code after output=$output", async ({ status, code, output }) => {
    const resolveRequestApiKey = vi.fn().mockResolvedValue("synthetic-current");
    const provider = vi.fn<StreamFn>(() => {
      const stream = createAssistantMessageEventStream();
      if (output) {
        stream.push({ type: "start", partial: done });
      }
      stream.push({
        type: "error",
        reason: "error",
        error: {
          ...done,
          stopReason: "error",
          errorCode: code,
          errorMessage: String(status) + ": rejected",
        },
      });
      stream.end();
      return stream;
    });
    const { streamFn } = resolveEmbeddedAgentStream({
      llmRuntime: defaultLlmRuntime,
      currentStreamFn: undefined,
      providerStreamFn: provider,
      model,
      sessionId: "negative",
      resolveRequestApiKey,
    });
    expect((await (await streamFn(model, { messages: [] })).result()).errorCode).toBe(code);
    expect(provider).toHaveBeenCalledOnce();
    expect(resolveRequestApiKey).toHaveBeenCalledOnce();
  });
  it.each(["reject", "cancel", "rotate"])(
    "does not dispatch captured credentials when renewal %s",
    async (outcome) => {
      const pending = createDeferred<string>();
      const provider = vi.fn<StreamFn>();
      const abort = new AbortController();
      let current = true;
      const { streamFn } = resolveEmbeddedAgentStream({
        llmRuntime: defaultLlmRuntime,
        currentStreamFn: undefined,
        providerStreamFn: provider,
        model,
        sessionId: "fenced",
        resolvedApiKey: "synthetic-captured",
        signal: abort.signal,
        resolveRequestApiKey: () => pending.promise,
        assertCurrent: () => {
          if (!current) {
            throw new Error("rotated");
          }
        },
      });
      const request = Promise.resolve(
        streamFn(model, { messages: [] }, { apiKey: "synthetic-static" }),
      );
      const rejected = expect(request).rejects.toThrow();
      if (outcome === "reject") {
        pending.reject(new Error("owner failed"));
      } else {
        if (outcome === "cancel") {
          abort.abort();
        } else {
          current = false;
        }
        pending.resolve("synthetic-late");
      }
      await rejected;
      expect(provider).not.toHaveBeenCalled();
    },
  );
  it.each(["Authorization", "authorization"])(
    "bounds token_expired retries with captured %s headers",
    async (headerName) => {
      const requests: string[] = [];
      const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-openai-chatpass-test")).toBe("codex-direct");
        requests.push(headers.get("authorization") ?? "");
        return new Response(
          JSON.stringify({ error: { code: "token_expired", message: "expired" } }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        );
      });
      configureAiTransportHost({ ...getAiTransportHost(), buildModelFetch: () => fetchMock });
      const resolveRequestApiKey = vi
        .fn()
        .mockResolvedValueOnce("synthetic-old")
        .mockResolvedValueOnce("synthetic-renewed");
      const fullModel = {
        ...model,
        name: model.id,
        headers: { [headerName]: "Bearer synthetic-captured-header" },
        baseUrl: "https://api.openai.com/v1",
        reasoning: false,
        input: ["text"] as "text"[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8000,
        maxTokens: 1000,
      };
      const selected = selectEmbeddedAgentStream({
        llmRuntime: defaultLlmRuntime,
        currentStreamFn: undefined,
        model: fullModel,
        sessionId: "fixture-retry",
        resolveRequestApiKey,
      });
      const { buildOpenAIProvider } = await loadBundledPluginFacade<{
        buildOpenAIProvider: () => ProviderPlugin;
      }>({ pluginId: "openai", artifactBasename: "api.ts" });
      const wrapped = buildOpenAIProvider().wrapStreamFn?.({
        provider: "openai",
        modelId: fullModel.id,
        model: fullModel,
        streamFn: selected.streamFn,
        auth: { mode: "oauth", authFlow: "chatgpt-token-sharing" },
      });
      if (!wrapped) {
        throw new Error("Expected the token-sharing provider wrapper");
      }
      const streamFn = selected.wrapApiKey(wrapped);
      const result = await (
        await streamFn(
          fullModel,
          { messages: [] },
          { transport: "sse", headers: { [headerName]: "Bearer synthetic-static-header" } },
        )
      ).result();
      expect(result).toMatchObject({ stopReason: "error", errorCode: "token_expired" });
      expect(requests).toEqual(["Bearer synthetic-old", "Bearer synthetic-renewed"]);
      expect(resolveRequestApiKey.mock.calls.map(([options]) => options.forceRefresh)).toEqual([
        false,
        true,
      ]);
    },
  );
  it("resolves the current selected credential again after a settled tool, ahead of captured keys", async () => {
    const keys: Array<string | undefined> = [];
    const provider: StreamFn = (_model, _context, options) => {
      keys.push(options?.apiKey);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: done });
      stream.end();
      return stream;
    };
    const resolveRequestApiKey = vi
      .fn()
      .mockResolvedValueOnce("synthetic-first")
      .mockResolvedValueOnce("synthetic-current");
    const { streamFn } = resolveEmbeddedAgentStream({
      llmRuntime: defaultLlmRuntime,
      currentStreamFn: undefined,
      providerStreamFn: provider,
      model,
      sessionId: "fixture-session",
      resolvedApiKey: "synthetic-captured",
      resolveRequestApiKey,
    });
    await (await streamFn(model, { messages: [] }, { apiKey: "synthetic-static" })).result();
    const settledTool = {
      role: "toolResult" as const,
      toolCallId: "settled",
      toolName: "fixture",
      content: [{ type: "text" as const, text: "already done" }],
      isError: false,
      timestamp: 2,
    };
    await (
      await streamFn(model, { messages: [settledTool] }, { apiKey: "synthetic-static" })
    ).result();
    expect(keys).toEqual(["synthetic-first", "synthetic-current"]);
  });
});
