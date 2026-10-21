import type { ControlUiSettingsPlacement } from "../../../src/plugin-sdk/control-ui-settings.js";

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
