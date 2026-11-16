/** Manifest-declared dashboard bindings borrow exact Board authority, never raw Gateway callers. */
export { captureDashboardDataBindingRead } from "../plugins/dashboard-data-binding-scope.js";
export type {
  PluginDashboardDataBindingV1,
  PluginDashboardDataBindingHost,
  PreparedPluginDashboardDataBinding,
} from "../plugins/dashboard-data-binding.types.js";

export { BoardValidationError } from "../boards/board-errors.js";
export { BoardGatewayUnavailableError } from "../boards/board-errors.js";
