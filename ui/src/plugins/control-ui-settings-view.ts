import { raceWithTimeout } from "@openclaw/retry";
import type { PluginControlUiModule } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import type { AnyControlUiSettingsPlacement as ControlUiSettingsPlacement } from "../../../src/plugin-sdk/control-ui-settings.js";
import { listen } from "../lib/reactive/listener.ts";
import { controlUiPluginAssetUrls } from "./control-ui-assets.ts";
import { controlUiPluginDistributions } from "./control-ui-distribution.ts";

function sameSettingsPlacement(a: ControlUiSettingsPlacement, b: ControlUiSettingsPlacement) {
  return (
    a.section === b.section &&
    a.panel === b.panel &&
    (!("id" in a) || ("id" in b && a.id === b.id)) &&
    (a.section !== "channels" || (b.section === "channels" && a.channelId === b.channelId))
  );
}

/** Module declarations must match the admitted metadata before a Settings view may mount. */
function resolveControlUiSettingsView(
  module: import("./control-ui-loader.ts").ControlUiPluginModule,
  distribution: {
    pluginId: string;
    settingsViews?: readonly ControlUiSettingsPlacement[];
  },
  placement: ControlUiSettingsPlacement,
) {
  if (
    module.pluginId !== distribution.pluginId ||
    !Array.isArray(module.settingsViews) ||
    module.settingsViews.length !== distribution.settingsViews?.length
  ) {
    throw new Error("Settings presentation does not match its packaged owner and placements.");
  }
  const declared = distribution.settingsViews?.every(
    (declaredPlacement) =>
      module.settingsViews!.filter(
        (view) =>
          typeof view.mount === "function" &&
          sameSettingsPlacement(declaredPlacement, view.placement),
      ).length === 1,
  );
  const views = module.settingsViews.filter((view) =>
    sameSettingsPlacement(view.placement, placement),
  );
  const view = views[0];
  if (!declared || views.length !== 1 || !view) {
    throw new Error("Invalid or duplicate Settings presentation.");
  }
  return view;
}

export async function loadPackagedSettingsView(
  placement: ControlUiSettingsPlacement,
  signal: AbortSignal,
  lifetimes: Map<AbortController, { pluginId: string; revision: string; admitted: boolean }>,
  options: {
    pluginId?: string;
    catalog: readonly PluginControlUiModule[];
    resourceBasePath: string;
  },
) {
  signal.throwIfAborted();
  // Disabled Memory/channel setup remains package-owned; general views require catalog admission.
  const candidates = "id" in placement ? options.catalog : controlUiPluginDistributions;
  const matches = candidates.filter(
    (entry) =>
      (!options.pluginId || entry.pluginId === options.pluginId) &&
      entry.settingsViews?.some((item) => sameSettingsPlacement(item, placement)),
  );
  if (matches.length !== 1) {
    throw new Error("Settings presentation requires one packaged owner.");
  }
  const distribution = matches[0]!;
  const abort = new AbortController();
  const lifetime = AbortSignal.any([signal, abort.signal]);
  const disposers = new Set<() => void>();
  let retired = false;
  const dispose = () => {
    if (retired) {
      return;
    }
    retired = true;
    abort.abort();
    for (const stop of disposers) {
      stop();
    }
    disposers.clear();
    lifetimes.delete(abort);
  };
  lifetimes.set(abort, {
    pluginId: distribution.pluginId,
    revision: distribution.revision,
    admitted: "id" in placement,
  });
  disposers.add(listen(lifetime, "abort", dispose, { once: true }));
  const styles: HTMLLinkElement[] = [];
  try {
    const { loadControlUiPluginAssets } = await import("./control-ui-loader.ts");
    const module = await raceWithTimeout(
      loadControlUiPluginAssets(
        distribution.pluginId,
        "entryUrl" in distribution
          ? controlUiPluginAssetUrls(distribution, options.resourceBasePath)
          : distribution,
        lifetime,
        (stop) => disposers.add(stop),
        styles,
      ),
      15_000,
      () => {
        throw new Error("Settings presentation timed out.");
      },
    );
    lifetime.throwIfAborted();
    const view = resolveControlUiSettingsView(module, distribution, placement);
    for (const style of styles) {
      style.media = "all";
    }
    return { view, signal: lifetime, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
