import { createEffect, createRoot, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { EMPTY_SESSION_MENU_DATA } from "../components/session-menu-data.ts";
import { SessionMenu } from "../components/session-menu-solid.tsx";
import { i18n } from "../i18n/lib/translate.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { menuItem, menuItemLabels, menuPanel } from "../test-helpers/session-menu.ts";
import {
  createSessionMenuActionsProjection,
  observeSessionMenuActions,
} from "./control-ui-action-observation.solid.ts";
import { pluginSessionMenuActions, runControlUiPluginAction } from "./control-ui-actions.ts";
import type { ControlUiPluginDistribution } from "./control-ui-distribution.ts";
import { createControlUiPluginHost } from "./control-ui-host.ts";
import * as controlUiLoader from "./control-ui-loader.ts";
import {
  assetPath,
  catalog,
  configForRuntime,
  connectedContext,
  diagnostic,
  disposeTestRuntimes,
  localGateway,
  pluginDescriptor,
  runtimeFor,
  trackTestRuntime,
} from "./control-ui-runtime.test-support.ts";
import { ControlUiPluginRuntime } from "./control-ui-runtime.ts";
import { createTextReferenceProjection } from "./control-ui-text-reference-projection.ts";

vi.spyOn(controlUiLoader, "initializeControlUiPlugin").mockResolvedValue(undefined);
const packaged = vi.hoisted(() => [] as ControlUiPluginDistribution[]);
vi.mock("./control-ui-distribution.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-ui-distribution.ts")>()),
  controlUiPluginDistributions: packaged,
}));

afterEach(() => {
  disposeTestRuntimes();
  vi.mocked(controlUiLoader.initializeControlUiPlugin).mockReset().mockResolvedValue(undefined);
  vi.unstubAllGlobals();
});

it("bounds action observations and effect authority to live registrations", async () => {
  let descriptors = [pluginDescriptor("one", `${assetPath()}index.js`)];
  const context = connectedContext(
    {
      gatewayUrl: localGateway(),
      request: async (method) =>
        method === "plugins.controlUi.list" ? catalog(descriptors) : { ok: true },
    },
    configForRuntime(),
  );
  let available = false;
  let announce = () => {};
  let interests = 0;
  let withdraw = () => {};
  let withdrawDuringResolve = false;
  let withdrawDuringObserve = false;
  const run = vi.fn();
  vi.mocked(controlUiLoader.initializeControlUiPlugin).mockImplementation(
    async (getContext, runtime, owner) => {
      const host = createControlUiPluginHost(getContext, runtime, owner);
      withdraw = host.ui.registerAction({
        id: "review",
        label: "Review",
        placement: "session",
        resolve() {
          if (withdrawDuringResolve) {
            withdraw();
          }
          return { hidden: !available };
        },
        observe(_target, changed) {
          announce = changed;
          interests++;
          if (withdrawDuringObserve) {
            withdraw();
          }
          return () => {
            interests--;
          };
        },
        run,
      });
      return Object.assign(owner, { host });
    },
  );
  const runtime = runtimeFor(context);
  runtime.start();
  await runtime.refresh();
  const session = {
    key: "agent:main:review",
    agentId: "main",
    kind: "direct",
    updatedAt: 1,
  } satisfies GatewaySessionRow;
  const notified = vi.fn();
  const close = observeSessionMenuActions(runtime, session, notified);
  expect(interests).toBe(1);
  expect(pluginSessionMenuActions(runtime, session)).toEqual([]);
  const invoke = () =>
    runControlUiPluginAction({
      runtime,
      id: "review/review",
      placement: "session",
      sessionKey: session.key,
      session,
      signal: new AbortController().signal,
    });
  await expect(invoke()).rejects.toThrow(i18n.t("pluginUi.actionUnavailableSession"));
  expect(run).not.toHaveBeenCalled();
  available = true;
  announce();
  expect(notified).toHaveBeenCalledOnce();
  expect(pluginSessionMenuActions(runtime, session)).toMatchObject([{ label: "Review" }]);
  await invoke();
  expect(run).toHaveBeenCalledOnce();
  const retiredCallback = announce;
  close();
  expect(interests).toBe(0);
  const notifications = notified.mock.calls.length;
  retiredCallback();
  expect(notified).toHaveBeenCalledTimes(notifications);
  const closeAgain = observeSessionMenuActions(runtime, session, notified);
  withdrawDuringResolve = true;
  await expect(invoke()).rejects.toThrow();
  expect(run).toHaveBeenCalledOnce();
  expect(interests).toBe(0);
  closeAgain();
  withdrawDuringResolve = false;
  descriptors = [pluginDescriptor("two", `${assetPath("two")}index.js`)];
  await runtime.refresh();
  withdrawDuringObserve = true;
  const synchronous = observeSessionMenuActions(runtime, session, notified);
  expect(interests).toBe(0);
  synchronous();
  expect(interests).toBe(0);
  withdrawDuringObserve = false;
  descriptors = [pluginDescriptor("three", `${assetPath("three")}index.js`)];
  await runtime.refresh();
  const replacement = observeSessionMenuActions(runtime, session, notified);
  expect(interests).toBe(1);
  descriptors = [];
  await runtime.refresh();
  expect(interests).toBe(0);
  expect(pluginSessionMenuActions(runtime, session)).toEqual([]);
  replacement();
});

it.each(["review", "reader"])(
  "admits references only with declared reader owner %s and retires observations and retained resolvers",
  async (readerPluginId) => {
    let descriptors = [pluginDescriptor("one", `${assetPath()}index.js`)];
    let context = connectedContext(
      {
        gatewayUrl: localGateway(),
        request: async (method) =>
          method === "plugins.controlUi.list" ? catalog(descriptors) : { ok: true },
      },
      configForRuntime(),
    );
    const listeners = new Set<() => void>();
    context.gateway.subscribe = (changed) => {
      const notify = () => changed(context.gateway.snapshot);
      listeners.add(notify);
      return () => listeners.delete(notify);
    };
    const publish = () => {
      listeners.forEach((changed) => changed());
      flush();
    };
    const reader = {
      pluginId: "review",
      id: "items",
      label: "Review",
      linkReader: {
        hosts: ["github.com"],
        pathPattern: "^/acme/current/pull/[0-9]+$",
        detailMethod: "review.detail",
      },
    };
    const setReader = (pluginId?: string) => {
      Object.assign(context.gateway.snapshot, {
        hello: {
          ...context.gateway.snapshot.hello,
          auth: { role: "operator", scopes: ["operator.read"] },
        },
        pluginCapabilities: {
          methods: ["review.detail"],
          controlUiLinkReaders: pluginId ? [{ ...reader, pluginId }] : [],
        },
      });
      publish();
    };
    let interests = 0;
    let releases = 0;
    let withdraw = () => {};
    let synchronouslyWithdraw = false;
    vi.mocked(controlUiLoader.initializeControlUiPlugin).mockImplementation(
      async (getContext, runtime, owner) => {
        const host = createControlUiPluginHost(getContext, runtime, owner);
        withdraw = host.ui.registerTextReferenceProvider({
          id: "shorthand",
          reader: { pluginId: readerPluginId, id: "items" },
          snapshot: () => ({
            key: "same",
            resolve: () => [
              { start: 0, end: 5, url: "https://github.com/acme/current/pull/1" },
              { start: 6, end: 11, url: "https://other.example/pull/2" },
            ],
          }),
          observe() {
            interests++;
            if (synchronouslyWithdraw) {
              withdraw();
            }
            return () => {
              interests--;
              releases++;
            };
          },
        });
        return Object.assign(owner, { host });
      },
    );
    const runtime = trackTestRuntime(new ControlUiPluginRuntime(() => context));
    context = { ...context, plugins: runtime };
    runtime.start();
    await runtime.refresh();
    let latest: ReturnType<ReturnType<typeof createTextReferenceProjection>>;
    const dispose = createRoot((stopRoot) => {
      const references = createTextReferenceProjection(() => ({
        context,
        session: { sessionKey: "agent:main:one" },
        presented: true,
      }));
      createEffect(references, (value) => {
        latest = value;
      });
      return stopRoot;
    });
    onTestFinished(dispose);
    flush();
    expect(latest?.snapshots ?? []).toEqual([]);
    expect(interests).toBe(0);
    setReader("foreign");
    expect(latest?.snapshots ?? []).toEqual([]);
    setReader(readerPluginId);
    expect(interests).toBe(1);
    const stable = latest;
    publish();
    expect(latest).toBe(stable);
    const retained = latest!.snapshots[0]!;
    expect(retained.resolve({ text: "PR #1", links: [] })).toHaveLength(1);
    setReader();
    expect(latest?.snapshots ?? []).toEqual([]);
    expect(interests).toBe(0);
    expect(releases).toBe(1);
    expect(retained.resolve({ text: "PR #1", links: [] })).toEqual([]);
    setReader(readerPluginId);
    expect(interests).toBe(1);
    descriptors = [pluginDescriptor("two", `${assetPath("two")}index.js`)];
    synchronouslyWithdraw = true;
    await runtime.refresh();
    flush();
    expect(interests).toBe(0);
    expect(latest?.snapshots ?? []).toEqual([]);
    // A provider may withdraw inside observe before returning its cleanup.
    expect(releases).toBe(3);
    synchronouslyWithdraw = false;
    descriptors = [pluginDescriptor("three", `${assetPath("three")}index.js`)];
    await runtime.refresh();
    flush();
    expect(interests).toBe(1);
    dispose();
    expect(interests).toBe(0);
    expect(releases).toBe(4);
  },
);

it("isolates two failing plugin resolvers while the native session menu remains usable", async () => {
  const context = connectedContext({
    gatewayUrl: localGateway(),
    request: async (method) =>
      method === "plugins.controlUi.list" ? catalog([pluginDescriptor()]) : { ok: true },
  });
  const resolves = [vi.fn(), vi.fn()];
  vi.mocked(controlUiLoader.initializeControlUiPlugin).mockImplementation(
    async (getContext, runtime, owner) => {
      const host = createControlUiPluginHost(getContext, runtime, owner);
      for (const [index, resolve] of resolves.entries()) {
        host.ui.registerAction({
          id: `broken-${index}`,
          label: `Broken ${index}`,
          placement: "session",
          resolve() {
            resolve();
            // Keep the regression bounded even if diagnostic publication recursively resolves actions.
            if (resolve.mock.calls.length > 12) {
              return { hidden: true };
            }
            throw new Error(`Synthetic action failure ${index}`);
          },
          run() {},
        });
      }
      host.ui.registerAction({
        id: "healthy",
        label: "Healthy plugin action",
        placement: "session",
        run() {},
      });
      return Object.assign(owner, { host });
    },
  );
  const runtime = runtimeFor(context);
  runtime.start();
  await runtime.refresh();
  const selected = {
    key: "agent:main:review",
    agentId: "main",
    kind: "direct",
    updatedAt: 1,
  } satisfies GatewaySessionRow;
  const onAction = vi.fn();
  const mounted = mountSolid(() => {
    const actions = createSessionMenuActionsProjection(() => ({ runtime, session: selected }));
    return SessionMenu({
      session: { ...EMPTY_SESSION_MENU_DATA, ...selected },
      get pluginActions() {
        return actions();
      },
      archiveAllowed: true,
      onAction,
    });
  });
  const menu = mounted.container.querySelector("openclaw-session-menu")!;
  await menu.updateComplete;
  await vi.waitFor(() => expect(menuItemLabels(menu)).toContain("Healthy plugin action"));
  expect(menuPanel(menu).matches(":popover-open")).toBe(true);
  expect(menuItemLabels(menu)).not.toContain("Broken 0");
  expect(menuItemLabels(menu)).not.toContain("Broken 1");
  expect(runtime.errors.length).toBeLessThanOrEqual(20);
  expect(runtime.errors).toContainEqual(diagnostic("Synthetic action failure 1"));
  for (const resolve of resolves) {
    expect(resolve.mock.calls.length).toBeLessThanOrEqual(6);
  }
  menuItem(menu, "Archive session").click();
  expect(onAction).toHaveBeenCalledWith({ kind: "toggle-archived" });
});
