import type { ControlUiRepositorySource } from "../../../packages/gateway-protocol/src/plugin-control-ui-repositories.js";
import type { PluginsControlUiCatalog } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import type { AnyControlUiSettingsPlacement as ControlUiSettingsPlacement } from "../../../src/plugin-sdk/control-ui-settings.js";

export type ControlUiSettingsContribution = {
  pluginId: string;
  revision: string;
  placement: ControlUiSettingsPlacement;
};
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
