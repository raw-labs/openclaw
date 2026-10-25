import type {
  ExecutionEnvironmentPreparationV1,
  PreparedExecutionEnvironment,
  PreparedSandboxExecutionEnvironment,
  SandboxExecutionEnvironmentPreparationV1,
} from "../plugins/execution-environment-types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { SecretExecutionEnvironmentExclusions } from "../secrets/runtime-shared.js";
import type { PreparedGitHubToolEnvironment } from "./github-tool-identity.types.js";

type SharedEnvironmentFacts = Pick<
  PreparedExecutionEnvironment,
  "credentialScrubEnv" | "localIdentityEnv" | "wrapLocalLaunch"
> &
  Partial<
    Pick<
      PreparedExecutionEnvironment,
      "excludedStoreNames" | "localGitConfigParameters" | "hostExecutionRequired"
    >
  >;
type Contribution = { owner: string; environment: SharedEnvironmentFacts };
type CurrentExecutionEnvironment = { assertCurrent: () => void };

function combine(
  values: readonly Contribution[],
  assertCurrent: () => void,
  exclusions?: SecretExecutionEnvironmentExclusions,
): PreparedExecutionEnvironment {
  const credentialScrubEnv: Record<string, string> = {};
  const localIdentityEnv: Record<string, string> = {};
  const owners = new Map<string, string>();
  const excludedStoreNames = new Set(exclusions?.excludedStoreNames);
  const gitParameters: string[] = [];
  const wrappers: NonNullable<PreparedExecutionEnvironment["wrapLocalLaunch"]>[] = [];
  let hostExecutionRequired = false;
  for (const { owner, environment } of values) {
    Object.assign(credentialScrubEnv, environment.credentialScrubEnv);
    for (const [name, value] of Object.entries(environment.localIdentityEnv)) {
      if (Object.hasOwn(localIdentityEnv, name) && localIdentityEnv[name] !== value) {
        throw new Error(
          `Execution environment owners ${owners.get(name)} and ${owner} disagree on ${name}.`,
        );
      }
      owners.set(name, owner);
      localIdentityEnv[name] = value;
    }
    environment.excludedStoreNames?.forEach((name) => excludedStoreNames.add(name));
    if (environment.localGitConfigParameters) {
      gitParameters.push(environment.localGitConfigParameters);
    }
    if (environment.wrapLocalLaunch) {
      wrappers.push(environment.wrapLocalLaunch);
    }
    hostExecutionRequired ||=
      environment.hostExecutionRequired === true || Boolean(environment.wrapLocalLaunch);
  }
  Object.assign(credentialScrubEnv, exclusions?.credentialScrubEnv);
  return Object.freeze({
    credentialScrubEnv: Object.freeze(credentialScrubEnv),
    localIdentityEnv: Object.freeze(localIdentityEnv),
    excludedStoreNames: Object.freeze([...excludedStoreNames]),
    ...(gitParameters.length ? { localGitConfigParameters: gitParameters.join(" ") } : {}),
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

function preparationGuard(
  input: ExecutionEnvironmentPreparationV1,
  registrations: PluginRegistry["executionEnvironments"],
) {
  const owners = registrations.map((entry) => entry.assertCurrent);
  return () => {
    input.assertCurrent();
    input.signal?.throwIfAborted();
    owners.forEach((assertCurrent) => assertCurrent());
  };
}

/** Compose optional plugin facts without transferring the native identity owner's decisions. */
export function capturePreparedExecutionEnvironment(
  input: ExecutionEnvironmentPreparationV1,
  native: PreparedGitHubToolEnvironment,
  registry: PluginRegistry | null | undefined,
  exclusions?: SecretExecutionEnvironmentExclusions,
): PreparedGitHubToolEnvironment & PreparedExecutionEnvironment & CurrentExecutionEnvironment {
  const assertCurrent = preparationGuard(input, registry?.executionEnvironments ?? []);
  assertCurrent();
  const prepared: Contribution[] = [{ owner: "native", environment: native }];
  for (const { pluginId, provider } of registry?.executionEnvironments ?? []) {
    prepared.push({ owner: `${pluginId}:${provider.id}`, environment: provider.prepare(input) });
    assertCurrent();
  }
  return {
    ...combine(prepared, assertCurrent, exclusions),
    assertCurrent,
    // This private flag controls native GitHub token inheritance and profile selection.
    // An unrelated plugin environment must never change that native decision.
    managedLocalIdentity: native.managedLocalIdentity,
  };
}

/** Sandbox adapters explicitly opt in; local process overlays are never copied into containers. */
export async function prepareSandboxExecutionEnvironment(
  input: SandboxExecutionEnvironmentPreparationV1,
  registry: PluginRegistry | null | undefined,
  native?: PreparedSandboxExecutionEnvironment,
  exclusions?: SecretExecutionEnvironmentExclusions,
): Promise<(PreparedSandboxExecutionEnvironment & CurrentExecutionEnvironment) | undefined> {
  const providers = (registry?.executionEnvironments ?? []).filter(
    ({ provider }) => provider.prepareSandbox,
  );
  const assertCurrent = preparationGuard(input, providers);
  assertCurrent();
  const prepared: Array<Contribution & { environment: PreparedSandboxExecutionEnvironment }> = [];
  if (native) {
    prepared.push({ owner: "native", environment: native });
  }
  for (const { pluginId, provider } of providers) {
    const environment = await provider.prepareSandbox?.(input);
    assertCurrent();
    if (environment) {
      prepared.push({ owner: `${pluginId}:${provider.id}`, environment });
    }
  }
  if (
    !prepared.length &&
    !Object.keys(exclusions?.credentialScrubEnv ?? {}).length &&
    !exclusions?.excludedStoreNames.length
  ) {
    return undefined;
  }
  const mounts = new Map<string, { owner: string; hostPath: string }>();
  for (const { owner, environment } of prepared) {
    for (const mount of environment.readOnlyResourceMounts) {
      const previous = mounts.get(mount.containerPath);
      if (previous && previous.hostPath !== mount.hostPath) {
        throw new Error(
          `Execution environment owners ${previous.owner} and ${owner} disagree on sandbox mount ${mount.containerPath}.`,
        );
      }
      mounts.set(mount.containerPath, { owner, hostPath: mount.hostPath });
    }
  }
  return {
    ...combine(prepared, assertCurrent, exclusions),
    assertCurrent,
    readOnlyResourceMounts: [...mounts].map(([containerPath, { hostPath }]) => ({
      hostPath,
      containerPath,
    })),
    inheritedEnvironmentNames: [
      ...new Set(prepared.flatMap(({ environment }) => environment.inheritedEnvironmentNames)),
    ],
  };
}
