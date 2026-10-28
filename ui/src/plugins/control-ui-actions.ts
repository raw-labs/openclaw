import type { BoardGetParams } from "@openclaw/gateway-protocol";
import type {
  ControlUiActionV2 as ControlUiAction,
  ControlUiSession,
} from "../../../src/plugin-sdk/control-ui.js";
import type { PluginSessionMenuAction } from "../components/session-menu-solid.tsx";
import { listen } from "../lib/reactive/listener.ts";
import type { ControlUiPluginCapability } from "./control-ui-capability.ts";
import { scopeControlUiHost } from "./control-ui-scope.ts";

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
  const retry =
    params.placement === "session"
      ? "Reopen the session menu."
      : "Try again from the current view.";
  if (params.placement === "session" && !params.session) {
    throw new Error(`This session is no longer available. ${retry}`);
  }
  const entry = params.runtime
    .registrations("actions")
    .find(
      (candidate) => candidate.key === params.id && candidate.value.placement === params.placement,
    );
  if (!entry) {
    throw new Error(`This plugin action is no longer active. ${retry}`);
  }
  const signal = AbortSignal.any([params.signal, entry.signal]);
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
  const state = entry.value.resolve?.(context);
  // A resolver can synchronously withdraw its registration or remove the view.
  check();
  if (state?.hidden || state?.disabled) {
    throw new Error(`This plugin action is currently unavailable. ${retry}`);
  }
  await entry.value.run({
    ...context,
    host: scopeControlUiHost(entry.host, signal, params.isCurrent),
    signal,
  });
  check();
}

/** Observe active session actions without retaining a hidden menu or a retired plugin. */
export function observeSessionMenuActions(
  runtime: ControlUiPluginCapability,
  session: ControlUiSession,
  notify: () => void,
): () => void {
  let live = true;
  const observed = new Map<AbortSignal, () => void>();
  const changed = () => {
    if (live) {
      notify();
    }
  };
  const reconcile = () => {
    const entries = runtime
      .registrations("actions")
      .filter(
        (entry) =>
          entry.value.placement === "session" && entry.value.observe && !entry.signal.aborted,
      );
    const current = new Set(entries.map((entry) => entry.signal));
    for (const [signal, stop] of observed) {
      if (!current.has(signal)) {
        observed.delete(signal);
        stop();
      }
    }
    for (const entry of entries) {
      if (observed.has(entry.signal) || !entry.value.observe) {
        continue;
      }
      const lifetime = new AbortController();
      const signal = AbortSignal.any([entry.signal, lifetime.signal]);
      let ended = false;
      let stop: (() => void) | undefined;
      const retire = () => {
        if (ended) {
          return;
        }
        ended = true;
        stopAbort();
        lifetime.abort();
        stop?.();
      };
      // Register custody before calling plugin code, which may synchronously withdraw itself.
      observed.set(entry.signal, retire);
      const stopAbort = listen(entry.signal, "abort", retire, { once: true });
      try {
        const cleanup = entry.value.observe(
          {
            sessionKey: session.key,
            agentId: session.agentId,
            session: structuredClone(session),
            signal,
          },
          () => {
            if (!signal.aborted) {
              changed();
            }
          },
        );
        if (ended) {
          cleanup();
        } else {
          stop = cleanup;
        }
      } catch (error) {
        retire();
        runtime.reportError(entry.pluginId, error);
      }
    }
  };
  const stopRuntime = runtime.subscribe(() => {
    reconcile();
    changed();
  });
  reconcile();
  return () => {
    live = false;
    stopRuntime();
    for (const stop of observed.values()) {
      stop();
    }
    observed.clear();
  };
}
