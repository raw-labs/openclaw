import { onTestFinished } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createControlUiPluginHost } from "./control-ui-host.ts";
import { type ControlUiPluginOwner, ControlUiPluginRuntime } from "./control-ui-runtime.ts";
import { scopeControlUiHost } from "./control-ui-scope.ts";

export const subscribe = () => () => undefined;
export const subscriptions = Object.fromEntries(
  ["gateway", "sessions", "agents", "agentSelection", "theme"].map((name) => [name, { subscribe }]),
);

export function createHost(
  context: ApplicationContext,
  runtime?: ControlUiPluginRuntime,
  client?: GatewayBrowserClient,
) {
  const owner = {
    client,
    abort: new AbortController(),
    descriptor: { pluginId: "review" },
    disposers: new Set<() => void>(),
    contributions: { navigation: new Map(), panels: new Map() },
  } as Omit<ControlUiPluginOwner, "host">;
  const activeRuntime =
    runtime ??
    ({
      isCurrent: (current: Omit<ControlUiPluginOwner, "host">) =>
        current === owner && !current.abort.signal.aborted,
    } as ControlUiPluginRuntime);
  const dispose = () => {
    owner.abort.abort();
    owner.disposers.forEach((stop) => stop());
    owner.disposers.clear();
  };
  onTestFinished(dispose);
  return {
    owner,
    abort: owner.abort,
    dispose,
    host: createControlUiPluginHost(() => context, activeRuntime, owner),
  };
}

export function scopedHost(host: ReturnType<typeof createHost>["host"]) {
  const view = new AbortController();
  onTestFinished(() => view.abort());
  return { view, host: scopeControlUiHost(host, view.signal) };
}
