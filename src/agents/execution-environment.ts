import { AGENT_EXEC_GIT_CONFIG_PARAMETERS } from "../infra/host-env-security.js";
import type {
  ExecutionEnvironmentPreparationV1,
  PreparedExecutionEnvironment,
  PreparedSandboxExecutionEnvironment,
  SandboxExecutionEnvironmentPreparationV1,
} from "../plugins/execution-environment-types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { prepareExecutionEnvironmentExclusions } from "../secrets/runtime-execution-exclusions.js";

type ExecutionEnvironmentExclusions = Pick<
  PreparedExecutionEnvironment,
  "credentialScrubEnv" | "excludedStoreNames"
>;
function combine(
  values: readonly { owner: string; environment: PreparedExecutionEnvironment }[],
  exclusions: ExecutionEnvironmentExclusions | undefined,
  assertCurrent: () => void,
): PreparedExecutionEnvironment {
  const credentialScrubEnv: Record<string, string> = {};
  const localIdentityEnv: Record<string, string> = {};
  const excludedStoreNames = new Set<string>(exclusions?.excludedStoreNames ?? []);
  const selectedOwners = new Map<string, string>();
  const gitParameters: string[] = [AGENT_EXEC_GIT_CONFIG_PARAMETERS];
  const wrappers: NonNullable<PreparedExecutionEnvironment["wrapLocalLaunch"]>[] = [];
  let managedLocalIdentity = false;
  let hostExecutionRequired = false;
  for (const { owner, environment: value } of values) {
    Object.assign(credentialScrubEnv, value.credentialScrubEnv);
    for (const [name, fact] of Object.entries(value.localIdentityEnv)) {
      if (Object.hasOwn(localIdentityEnv, name) && localIdentityEnv[name] !== fact) {
        throw new Error(
          `Execution environment owners ${selectedOwners.get(name)} and ${owner} disagree on ${name}.`,
        );
      }
      localIdentityEnv[name] = fact;
      selectedOwners.set(name, owner);
    }
    value.excludedStoreNames.forEach((name) => excludedStoreNames.add(name));
    if (value.localGitConfigParameters) {
      gitParameters.push(value.localGitConfigParameters);
    }
    if (value.wrapLocalLaunch) {
      wrappers.push(value.wrapLocalLaunch);
    }
    managedLocalIdentity ||= value.managedLocalIdentity;
    hostExecutionRequired ||= value.hostExecutionRequired === true;
  }
  Object.assign(credentialScrubEnv, exclusions?.credentialScrubEnv);
  return Object.freeze({
    credentialScrubEnv: Object.freeze(credentialScrubEnv),
    localIdentityEnv: Object.freeze(localIdentityEnv),
    excludedStoreNames: Object.freeze([...excludedStoreNames]),
    managedLocalIdentity,
    localGitConfigParameters: gitParameters.join(" "),
    ...(hostExecutionRequired ? { hostExecutionRequired: true as const } : {}),
    ...(wrappers.length
      ? {
          wrapLocalLaunch: (argv: readonly string[]) => {
            assertCurrent();
            const wrapped = wrappers.reduce((current, wrap) => wrap(current), argv);
            assertCurrent();
            return wrapped;
          },
        }
      : {}),
  });
}

/** The selected runtime already owns plugin loading; capture its admitted contributions once. */
export function capturePreparedExecutionEnvironment(
  input: ExecutionEnvironmentPreparationV1,
  registry: PluginRegistry | undefined,
  exclusions?: ExecutionEnvironmentExclusions,
): PreparedExecutionEnvironment {
  input.assertCurrent();
  input.signal?.throwIfAborted();
  const prepared =
    registry?.executionEnvironments.map(({ pluginId, provider }) => ({
      owner: `${pluginId}:${provider.id}`,
      environment: provider.prepare(input),
    })) ?? [];
  input.assertCurrent();
  input.signal?.throwIfAborted();
  const preparedExclusions =
    exclusions ??
    prepareExecutionEnvironmentExclusions({
      config: input.sourceConfig ?? input.config,
    });
  return combine(prepared, preparedExclusions, () => {
    input.assertCurrent();
    input.signal?.throwIfAborted();
  });
}

export async function prepareSandboxExecutionEnvironment(
  input: SandboxExecutionEnvironmentPreparationV1,
  registry: PluginRegistry | undefined,
  exclusions?: ExecutionEnvironmentExclusions,
): Promise<PreparedSandboxExecutionEnvironment | undefined> {
  input.assertCurrent();
  input.signal?.throwIfAborted();
  const providers = registry?.executionEnvironments ?? [];
  const prepared: { owner: string; environment: PreparedSandboxExecutionEnvironment }[] = [];
  for (const { pluginId, provider } of providers) {
    const value = await provider.prepareSandbox?.(input);
    input.assertCurrent();
    input.signal?.throwIfAborted();
    if (value) {
      prepared.push({ owner: `${pluginId}:${provider.id}`, environment: value });
    }
  }
  if (!prepared.length) {
    return undefined;
  }
  const mounts = new Map<
    string,
    { owner: string; mount: PreparedSandboxExecutionEnvironment["readOnlyResourceMounts"][number] }
  >();
  for (const { owner, environment } of prepared) {
    for (const mount of environment.readOnlyResourceMounts) {
      const previous = mounts.get(mount.containerPath);
      if (previous && previous.mount.hostPath !== mount.hostPath) {
        throw new Error(
          `Execution environment owners ${previous.owner} and ${owner} disagree on sandbox mount ${mount.containerPath}.`,
        );
      }
      if (!previous) {
        mounts.set(mount.containerPath, { owner, mount });
      }
    }
  }
  return {
    ...combine(prepared, exclusions, () => {
      input.assertCurrent();
      input.signal?.throwIfAborted();
    }),
    readOnlyResourceMounts: [...mounts.values()].map(({ mount }) => mount),
    inheritedEnvironmentNames: [
      ...new Set(prepared.flatMap(({ environment }) => environment.inheritedEnvironmentNames)),
    ],
  };
}
