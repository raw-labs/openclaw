import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { createGitHubTextReferenceProvider } from "../../../extensions/github-repositories/browser/text-reference-api.ts";
import {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  createRepositoryBrowserRuntime,
} from "../../../extensions/github-repositories/session-pull-requests-api.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { ApplicationContext } from "../app/context.ts";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import {
  createGatewayHarness as createPullRequestGateway,
  flushSync,
} from "../lib/session-pull-requests.test-support.ts";
import { createTestSessionCapability } from "../lib/sessions/session-capability.test-support.ts";
import {
  createHost,
  scopedHost,
  subscribe,
  subscriptions,
} from "./control-ui-host.test-support.ts";

it("shares native PR read interest and retires scoped read/translation/navigation handles", async () => {
  const harness = createPullRequestGateway();
  // SAFETY: this host flow reads gateway plus the shared subscription-only services.
  const context = {
    ...subscriptions,
    gateway: harness.gateway,
    sessions: {
      subscribe,
      state: { agentId: "writer", result: null },
      captureConnectionScope: () => ({ client: harness.gateway.snapshot.client, epoch: 0 }),
      isConnectionScopeCurrent: () => true,
      capturePullRequestEpoch: () => ({}),
      pullRequestSummary: () => undefined,
      setPullRequestSummary() {},
    },
  } as unknown as ApplicationContext;
  const activation = createHost(context);
  const { view, host } = scopedHost(activation.host);
  const plugin = createRepositoryBrowserRuntime(activation.host);
  const reads = plugin;
  const native = plugin.store;
  const pane = {};
  const key = "agent:writer:global";
  const target = { sessionKey: "global", agentId: "writer" };
  native.watch(pane, [key], { foreground: true });
  const changed = vi.fn();
  const stop = reads.observe(target, changed);
  view.signal.addEventListener("abort", stop, { once: true });
  await flushSync();
  expect(harness.request).toHaveBeenCalledExactlyOnceWith(
    SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
    { sessionKeys: [key] },
    { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
  );
  harness.emit({
    sessions: {
      [key]: {
        pullRequests: [{ number: 421, state: "open" }],
        status: "ready",
        rateLimited: false,
      },
    },
  });
  expect(reads.read(target)).toBe(native.get(key));
  expect(reads.read(target)?.pullRequests[0]?.number).toBe(421);
  const heldRequest = host.requests.capture();
  expect(heldRequest?.isCurrent()).toBe(true);
  const read = host.requests.capture;
  const observe = host.requests.subscribe;
  const translate = expectDefined(host.presentation, "presentation").translate;
  const open = host.navigation.openExternal;
  const popup = vi.spyOn(window, "open").mockReturnValue(null).mockClear();
  open("javascript:alert(1)");
  expect(popup).not.toHaveBeenCalled();
  open("https://example.test/pr");
  expect(popup).toHaveBeenCalledExactlyOnceWith(
    "https://example.test/pr",
    "_blank",
    "noopener,noreferrer",
  );
  registerSessionOrganizationEnglish();
  expect(translate("sessionsView.openPullRequest")).toBe("Open PR");
  view.abort();
  stop();
  expect(heldRequest?.isCurrent()).toBe(false);
  await expect(heldRequest?.request("controlUi.sessionPullRequests.subscribe", {})).rejects.toThrow(
    "view has ended",
  );
  const delivered = changed.mock.calls.length;
  harness.emit({
    sessions: { [key]: { pullRequests: [{ number: 422 }], status: "ready", rateLimited: false } },
  });
  expect(changed).toHaveBeenCalledTimes(delivered);
  expect(native.get(key)?.pullRequests[0]?.number).toBe(422);
  await flushSync();
  expect(harness.request).toHaveBeenCalledTimes(1);
  for (const operation of [
    () => read(),
    () => observe(changed),
    () => translate("sessionsView.openPullRequest"),
    () => open("https://example.test/stale"),
  ]) {
    expect(operation).toThrow("view has ended");
  }
  native.unwatch(pane);
  plugin.store.dispose();
  expect(native.get(key)).toBeUndefined();
  const baseRead = activation.host.requests.capture;
  const baseTranslate = expectDefined(activation.host.presentation, "presentation").translate;
  const baseOpen = activation.host.navigation.openExternal;
  activation.dispose();
  for (const operation of [
    () => baseRead(),
    () => baseTranslate("sessionsView.openPullRequest"),
    () => baseOpen("https://example.test/stale"),
  ]) {
    expect(operation).toThrow("activation has ended");
  }
});

it("fences late project aliases on same-client scope changes through the scoped host", async () => {
  const h = createPullRequestGateway();
  const initial = h.gateway.snapshot;
  const hello = {
    ...initial.hello!,
    features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, "projects.list"] },
    auth: { ...initial.hello!.auth!, recoveryScope: "first" },
  };
  h.setSnapshot({ ...initial, hello });
  const pending = [createDeferred<unknown>(), createDeferred<unknown>()];
  let projectReads = 0;
  h.request.mockImplementation(async (method) =>
    method === "projects.list" ? pending[projectReads++]!.promise : { subscribed: true },
  );
  // The real host and native PR store serve the plugin; only Gateway transport replies are simulated.
  const context = {
    ...subscriptions,
    gateway: h.gateway,
    sessions: {
      subscribe,
      state: { agentId: "writer", result: null },
      captureConnectionScope: () => ({ client: h.gateway.snapshot.client, epoch: 0 }),
      isConnectionScopeCurrent: () => true,
      capturePullRequestEpoch: () => ({}),
      pullRequestSummary: () => undefined,
      setPullRequestSummary() {},
    },
  } as unknown as ApplicationContext;
  const activation = createHost(context, undefined, h.gateway.snapshot.client!);
  const provider = createGitHubTextReferenceProvider(
    activation.host,
    createRepositoryBrowserRuntime(activation.host),
  );
  const target = { sessionKey: "agent:main:main", signal: new AbortController().signal };
  const stop = provider.observe!(target, vi.fn());
  onTestFinished(stop);
  await vi.waitFor(() => expect(projectReads).toBe(1));
  const firstScope = activation.host.connection.readScopeKey;
  h.setSnapshot({ ...h.gateway.snapshot, sessionKey: "agent:main:unrelated" });
  expect(activation.host.connection.readScopeKey).toBe(firstScope);
  expect(projectReads).toBe(1);
  h.setSnapshot({
    ...h.gateway.snapshot,
    hello: { ...hello, auth: { ...hello.auth, recoveryScope: "second" } },
  });
  expect(activation.host.connection.readScopeKey).not.toBe(firstScope);
  await vi.waitFor(() => expect(projectReads).toBe(2));
  const aliases = (owner: string) => ({
    projects: [
      {
        id: "widget",
        displayName: "Widget",
        originUrl: `https://github.com/${owner}/widget`,
        source: "registered",
      },
    ],
  });
  pending[1]!.resolve(aliases("current"));
  await vi.waitFor(() =>
    expect(provider.snapshot(target).resolve({ text: "Widget PR #2", links: [] })[0]?.url).toBe(
      "https://github.com/current/widget/pull/2",
    ),
  );
  pending[0]!.resolve(aliases("retired"));
  await flushSync();
  expect(provider.snapshot(target).resolve({ text: "Widget PR #2", links: [] })[0]?.url).toBe(
    "https://github.com/current/widget/pull/2",
  );
  stop();
  expect(provider.snapshot(target).resolve({ text: "Widget PR #2", links: [] })).toEqual([]);
});

it.each(["truncated history", "merged", "empty rate-limited", "withdrawn rate-limited"] as const)(
  "projects pushed plugin PR facts through the captured native summary sink: %s",
  async (mode) => {
    const h = createPullRequestGateway();
    const sessions = createTestSessionCapability(h.gateway);
    onTestFinished(() => sessions.dispose());
    const activation = createHost({
      ...subscriptions,
      gateway: h.gateway,
      sessions,
    } as unknown as ApplicationContext);
    const runtime = createRepositoryBrowserRuntime(activation.host);
    const key = "agent:main:summary";
    const owner = {};
    sessions.setPullRequestSummary(key, { numbers: [111532], state: "merged" });
    runtime.store.watch(owner, [key], { foreground: true });
    await flushSync();
    const rateLimited = mode.endsWith("rate-limited");
    const requests =
      mode === "truncated history"
        ? [
            { number: 999, state: "draft" },
            ...Array.from({ length: 20 }, (_, i) => ({ number: i + 1, state: "closed" })),
          ]
        : rateLimited
          ? []
          : [{ number: 111532, state: "merged" }];
    h.emit({
      sessions: {
        [key]: {
          pullRequests: requests,
          rateLimited,
          status: rateLimited ? "rate-limited" : "ready",
          ...(mode === "withdrawn rate-limited" ? { discardPrevious: true } : {}),
        },
      },
    });
    expect(sessions.pullRequestSummary(key)).toEqual(
      mode === "withdrawn rate-limited"
        ? undefined
        : mode === "truncated history"
          ? { numbers: [...Array.from({ length: 19 }, (_, i) => i + 1), 999], state: "draft" }
          : { numbers: [111532], state: "merged" },
    );
    runtime.store.dispose();
  },
);

it("captures a fresh native roster epoch for new reads after reconnect", async () => {
  const h = createPullRequestGateway();
  const sessions = createTestSessionCapability(h.gateway);
  const activation = createHost({
    ...subscriptions,
    gateway: h.gateway,
    sessions,
  } as unknown as ApplicationContext);
  const runtime = createRepositoryBrowserRuntime(activation.host);
  const key = "agent:main:summary-reconnect";
  const owner = {};
  const publish = (number: number) =>
    h.emit({
      sessions: {
        [key]: { pullRequests: [{ number, state: "open" }], rateLimited: false, status: "ready" },
      },
    });
  runtime.store.watch(owner, [key], { foreground: true });
  await flushSync();
  publish(421);
  expect(sessions.pullRequestSummary(key)).toEqual({ numbers: [421], state: "open" });
  const hello = h.gateway.snapshot.hello;
  h.setSnapshot({ ...h.gateway.snapshot, phase: "reconnecting", hello: null });
  expect(sessions.pullRequestSummary(key)).toBeUndefined();
  h.setSnapshot({ ...h.gateway.snapshot, phase: "connected", hello });
  await flushSync();
  publish(422);
  expect(sessions.pullRequestSummary(key)).toEqual({ numbers: [422], state: "open" });
  runtime.store.dispose();
});
