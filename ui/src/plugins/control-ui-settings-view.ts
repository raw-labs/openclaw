import { raceWithTimeout } from "@openclaw/retry";
import type { PluginControlUiModule } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import type { AnyControlUiSettingsPlacement as ControlUiSettingsPlacement } from "../../../src/plugin-sdk/control-ui-settings.js";
import { listen } from "../lib/reactive/listener.ts";
import { controlUiPluginAssetUrls } from "./control-ui-assets.ts";
import { controlUiPluginDistributions } from "./control-ui-distribution.ts";
import { sameSettingsPlacement, resolveControlUiSettingsView } from "./control-ui-metadata.ts";

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
