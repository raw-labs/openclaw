import type { OpenClawConfig } from "../config/types.openclaw.js";

/** A Board grants the exact capability before the plugin can start or publish a read. */
export type PluginDashboardDataBindingHost = {
  agentId: string;
  getConfig: () => OpenClawConfig;
  getSourceConfig: () => OpenClawConfig;
  /** Opaque Gateway-lifetime cache identity. Never use it as caller authority. */
  cacheScope: object;
  assertCurrent: () => void;
  useCurrent: <T>(start: () => T) => Promise<Awaited<T>>;
  trackExecution: <T>(run: () => T | Promise<T>) => Promise<Awaited<T>>;
};

export type PreparedPluginDashboardDataBinding = {
  assertCurrent: () => void;
  start: <T>(run: () => T) => Promise<Awaited<T>>;
};

/** Runtime policy for a manifest-declared binding; it never grants access itself. */
export type PluginDashboardDataBindingV1 = {
  apiVersion: 1;
  /** The local id in this plugin's dashboard.dataBindings declaration. */
  id: string;
  resolveGrant: (params: Record<string, unknown>) => string;
  prepare: (host: PluginDashboardDataBindingHost) => Promise<PreparedPluginDashboardDataBinding>;
};
