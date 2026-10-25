import type { ControlUiRepositorySource } from "../../../packages/gateway-protocol/src/plugin-control-ui-repositories.js";
import type { PluginsControlUiCatalog } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import type { AnyControlUiSettingsPlacement as ControlUiSettingsPlacement } from "../../../src/plugin-sdk/control-ui-settings.js";

export type ControlUiSettingsContribution = {
  pluginId: string;
  revision: string;
  placement: ControlUiSettingsPlacement;
};
export function sameSettingsPlacement(
  a: ControlUiSettingsPlacement,
  b: ControlUiSettingsPlacement,
) {
  return (
    a.section === b.section &&
    a.panel === b.panel &&
    (!("id" in a) || ("id" in b && a.id === b.id)) &&
    (a.section !== "channels" || (b.section === "channels" && a.channelId === b.channelId))
  );
}

/** Module declarations must match the admitted metadata before a Settings view may mount. */
export function resolveControlUiSettingsView(
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

export type ControlUiRepositorySourceContribution = ControlUiRepositorySource & {
  pluginId: string;
  key: string;
};
/** Only admitted backend metadata supplies source selection, never browser registration. */
export function repositorySources(
  sources: NonNullable<PluginsControlUiCatalog["repositorySources"]>,
): ControlUiRepositorySourceContribution[] {
  return sources
    .map((source) => ({ ...source, key: `${source.pluginId}/${source.id}` }))
    .toSorted((a, b) => a.key.localeCompare(b.key));
}
