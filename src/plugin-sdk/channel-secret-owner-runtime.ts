/** Private bundled-channel seam for degraded secret-owner availability checks. */
export {
  assertSecretOwnerAvailable,
  isSecretOwnerAvailable,
  isTrustedSecretSurfaceUnavailableError,
  SecretSurfaceUnavailableError,
} from "../secrets/runtime-degraded-state.js";

export { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";

/** Names only: does not resolve dormant credentials or activate plugin code. */
export { prepareExecutionEnvironmentExclusions } from "../secrets/runtime-execution-exclusions.js";
