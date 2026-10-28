export { logConfigUpdated } from "../config/logging.js";
export { readConfigFileSnapshotForWrite } from "../config/io.js";
export { mutateConfigFile, replaceConfigFile } from "../config/mutate.js";
export type { ConfigWriteAfterWrite } from "../config/runtime-snapshot.js";
export { updateConfig } from "../commands/models/shared.js";

export type { AgentLifecycleBinding } from "../agents/agent-lifecycle-binding.js";
export type { AgentScopedPluginConfigMutation } from "../config/plugin-config-mutation.js";

/** Mutate only the named plugin block through the existing include-aware retrying writer. */
export async function mutateAgentScopedPluginConfig(
  ...args: Parameters<
    typeof import("../config/plugin-config-mutation.js").mutateAgentScopedPluginConfig
  >
): ReturnType<typeof import("../config/plugin-config-mutation.js").mutateAgentScopedPluginConfig> {
  const runtime = await import("../config/plugin-config-mutation.js");
  return runtime.mutateAgentScopedPluginConfig(...args);
}
