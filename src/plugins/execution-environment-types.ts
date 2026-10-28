import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Nonsecret facts prepared by an admitted optional execution owner. */
export type PreparedExecutionEnvironment = Readonly<{
  credentialScrubEnv: Readonly<Record<string, string>>;
  localIdentityEnv: Readonly<Record<string, string>>;
  excludedStoreNames: readonly string[];
  localGitConfigParameters?: string;
  /** Require host-owned tools when the runtime cannot apply the local launch adapter. */
  hostExecutionRequired?: true;
  /** Enclose the exact reviewed argv; credentials remain in the private child resolver. */
  wrapLocalLaunch?: (argv: readonly string[]) => readonly string[];
}>;
export type ExecutionEnvironmentPreparationV1 = Readonly<{
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  agentId: string;
  assertCurrent: () => void;
  signal?: AbortSignal;
}>;
export type SandboxExecutionEnvironmentPreparationV1 = ExecutionEnvironmentPreparationV1 &
  Readonly<{
    backend: string;
    scope: "agent" | "session" | "shared";
  }>;
export type PreparedSandboxExecutionEnvironment = Omit<
  PreparedExecutionEnvironment,
  "localGitConfigParameters" | "hostExecutionRequired" | "excludedStoreNames"
> &
  Readonly<{
    readOnlyResourceMounts: readonly Readonly<{ hostPath: string; containerPath: string }>[];
    inheritedEnvironmentNames: readonly string[];
  }>;
export type ExecutionEnvironmentProviderV1 = {
  id: string;
  prepare(this: void, input: ExecutionEnvironmentPreparationV1): PreparedExecutionEnvironment;
  prepareSandbox?(
    this: void,
    input: SandboxExecutionEnvironmentPreparationV1,
  ): Promise<PreparedSandboxExecutionEnvironment | undefined>;
};
