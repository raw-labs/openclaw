import { vi } from "vitest";
import type {
  ControlUiActionV2 as ControlUiAction,
  ControlUiHostV2 as ControlUiHost,
} from "../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../app/context.ts";
import { createControlUiRequests } from "../plugins/control-ui-requests.ts";

export function registerSessionPluginAction(
  context: Pick<ApplicationContext, "plugins" | "gateway">,
  action: ControlUiAction,
) {
  const lifetime = new AbortController();
  const open = vi.fn<ControlUiHost["sessions"]["open"]>();
  const host = {
    signal: lifetime.signal,
    requests: createControlUiRequests({
      current: () => context,
      signal: lifetime.signal,
      retain: (dispose) => dispose,
    }),
    sessions: { open },
    agents: {},
    navigation: {},
    ui: {},
    components: {},
  } as unknown as ControlUiHost;
  const entry = {
    key: `review/${action.id}`,
    pluginId: "review",
    value: action,
    signal: lifetime.signal,
    host,
  };
  Object.assign(context.plugins, {
    registrations: vi.fn((kind) => (kind === "actions" ? [entry] : [])),
  });
  return { entry, lifetime, open };
}
