import type { BoardGetParams } from "@openclaw/gateway-protocol";
import type {
  ControlUiActionV2 as ControlUiAction,
  ControlUiSession,
} from "../../../src/plugin-sdk/control-ui.js";
import type { PluginSessionMenuAction } from "../components/session-menu-solid.tsx";
import { i18n } from "../i18n/lib/translate.ts";
import type { ControlUiPluginCapability } from "./control-ui-capability.ts";

export function pluginSessionMenuActions(
  runtime: ControlUiPluginCapability,
  session: ControlUiSession,
): PluginSessionMenuAction[] {
  return runtime
    .registrations("actions")
    .filter((entry) => entry.value.placement === "session")
    .flatMap((entry) => {
      try {
        const state = entry.value.resolve?.({
          sessionKey: session.key,
          agentId: session.agentId,
          session: structuredClone(session),
        });
        return state?.hidden
          ? []
          : [
              {
                id: entry.key,
                label: state?.label ?? entry.value.label,
                disabled: state?.disabled,
                icon: entry.value.icon,
                shortcut: entry.value.shortcut,
                opensExternal: entry.value.opensExternal,
              },
            ];
      } catch (error) {
        runtime.reportError(entry.pluginId, error);
        return [];
      }
    });
}

export async function runControlUiPluginAction(
  params: BoardGetParams & {
    runtime: ControlUiPluginCapability;
    id: string;
    placement: ControlUiAction["placement"];
    session?: ControlUiSession;
    signal: AbortSignal;
    isCurrent?: () => boolean;
  },
): Promise<void> {
  // The lazy native-plugin loader installs action copy before exposing registrations.
  if (params.placement === "session" && !params.session) {
    throw new Error(i18n.t("pluginUi.actionSessionUnavailable"));
  }
  const entry = params.runtime
    .registrations("actions")
    .find(
      (candidate) => candidate.key === params.id && candidate.value.placement === params.placement,
    );
  if (!entry) {
    throw new Error(
      i18n.t(
        params.placement === "session"
          ? "pluginUi.actionInactiveSession"
          : "pluginUi.actionInactiveView",
      ),
    );
  }
  return entry.host.invokeAction(entry.value, entry.signal, params);
}
