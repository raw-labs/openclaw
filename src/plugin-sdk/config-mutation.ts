export { logConfigUpdated } from "../config/logging.js";
export { readConfigFileSnapshotForWrite } from "../config/io.js";
export { mutateConfigFile, replaceConfigFile } from "../config/mutate.js";
export type { ConfigWriteAfterWrite } from "../config/runtime-snapshot.js";
export { updateConfig } from "../commands/models/shared.js";

export { mutateConfigFileWithRetry } from "../config/config.js";
export { unsetConfigValueAtPath } from "../config/config-paths.js";
export async function readRepositoryPersistedConfig(): Promise<
  import("../config/types.openclaw.js").OpenClawConfig
> {
  const { createConfigIO } = await import("../config/io.factory.js");
  return await createConfigIO().loadConfigAsync();
}
