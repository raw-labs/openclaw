import type { ControlUiActionV2 as ControlUiAction } from "../../../src/plugin-sdk/control-ui.js";
import { i18n } from "../i18n/lib/translate.ts";
import type { PreparedControlUiHost, ControlUiActionInvocation } from "./control-ui-capability.ts";

/** Activation prepares this operation before publishing actions; admission stays synchronous. */
export async function invokeControlUiAction(
  host: PreparedControlUiHost,
  action: ControlUiAction,
  registrationSignal: AbortSignal,
  params: ControlUiActionInvocation,
): Promise<void> {
  const signal = AbortSignal.any([params.signal, registrationSignal]);
  const check = () => {
    signal.throwIfAborted();
    if (params.isCurrent?.() === false) {
      throw new Error("This plugin UI view has ended.");
    }
  };
  check();
  const context = {
    sessionKey: params.sessionKey,
    agentId: params.agentId ?? params.session?.agentId,
    session: params.session ? structuredClone(params.session) : undefined,
  };
  const state = action.resolve?.(context);
  // A resolver can synchronously withdraw its registration or remove the view.
  check();
  if (state?.hidden || state?.disabled) {
    throw new Error(
      i18n.t(
        action.placement === "session"
          ? "pluginUi.actionUnavailableSession"
          : "pluginUi.actionUnavailableView",
      ),
    );
  }
  await action.run({
    ...context,
    host: host.scopeView(signal, params.isCurrent),
    signal,
  });
  check();
}
