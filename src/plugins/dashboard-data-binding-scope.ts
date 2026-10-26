import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginDashboardDataBindingHost } from "./dashboard-data-binding.types.js";

const scope = resolveGlobalSingleton(
  Symbol.for("openclaw.dashboardDataBindingRead"),
  () => new AsyncLocalStorage<PluginDashboardDataBindingHost>(),
);

export async function withDashboardDataBindingRead<T>(
  host: PluginDashboardDataBindingHost,
  read: () => T,
): Promise<Awaited<T>> {
  let active = true;
  const assertCurrent = () => {
    if (!active) throw new Error("Dashboard data binding read is closed");
    host.assertCurrent();
  };
  const request: PluginDashboardDataBindingHost = Object.freeze({
    ...host,
    assertCurrent,
    getConfig: () => {
      assertCurrent();
      return host.getConfig();
    },
    getSourceConfig: () => {
      assertCurrent();
      return host.getSourceConfig();
    },
    useCurrent: async <T>(start: () => T): Promise<Awaited<T>> => {
      assertCurrent();
      return await host.useCurrent(() => {
        assertCurrent();
        return start();
      });
    },
    trackExecution: async <T>(run: () => T | Promise<T>): Promise<Awaited<T>> => {
      assertCurrent();
      // An admitted cache transport may finish after this widget read, but it cannot
      // start new work through a retained request facade once the read has settled.
      return await host.trackExecution(() => {
        assertCurrent();
        return run();
      });
    },
  });
  try {
    return await scope.run(request, read);
  } finally {
    active = false;
  }
}

/** A direct Gateway RPC cannot impersonate a widget's stored grant. */
export function captureDashboardDataBindingRead(): PluginDashboardDataBindingHost {
  const host = scope.getStore();
  if (!host) throw new Error("Dashboard data reads require an admitted Board widget grant");
  host.assertCurrent();
  return host;
}
