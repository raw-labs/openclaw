import type { PreparedSandboxExecutionEnvironment } from "../../plugins/execution-environment-types.js";

type Mount = PreparedSandboxExecutionEnvironment["readOnlyResourceMounts"][number];

/** Native GitHub identity joins sandbox preparation as one owner, with its profile mounted read-only. */
export function sandboxGitHubExecutionEnvironment(
  identity: Omit<
    PreparedSandboxExecutionEnvironment,
    "readOnlyResourceMounts" | "inheritedEnvironmentNames"
  >,
  mount: Mount,
): PreparedSandboxExecutionEnvironment {
  return {
    ...identity,
    localIdentityEnv: { ...identity.localIdentityEnv, GH_CONFIG_DIR: mount.containerPath },
    readOnlyResourceMounts: [mount],
    inheritedEnvironmentNames: [],
  };
}
