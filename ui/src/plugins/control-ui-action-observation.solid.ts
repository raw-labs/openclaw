import { createMemo } from "solid-js";
import type { ControlUiSession } from "../../../src/plugin-sdk/control-ui.js";
import { projectSource } from "../lib/reactive/projection.ts";
import { observeSessionMenuActions, pluginSessionMenuActions } from "./control-ui-actions.ts";
import type { ControlUiPluginCapability } from "./control-ui-capability.ts";

/** Menu lifetime owns interest; plugin state stays with its activation. */
export function createSessionMenuActionsProjection(
  read: () => {
    runtime?: ControlUiPluginCapability;
    session?: ControlUiSession;
  },
) {
  const source = createMemo(() =>
    projectSource(read(), {
      read: ({ runtime, session }) =>
        runtime && session ? pluginSessionMenuActions(runtime, session) : [],
      subscribe: ({ runtime, session }, notify) =>
        runtime && session ? observeSessionMenuActions(runtime, session, notify) : () => {},
      equality: "revision",
    }),
  );
  return () => source().read();
}
