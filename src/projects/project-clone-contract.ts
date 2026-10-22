import type { ProjectCloneFailureCause } from "../../packages/gateway-protocol/src/index.js";
import type { GitOperationStarter } from "../infra/git-network-retry.js";
export class ProjectCloneError extends Error {
  constructor(
    readonly failure: ProjectCloneFailureCause,
    message: string,
  ) {
    super(message);
    this.name = "ProjectCloneError";
  }
}

/** Source adapters do not select host configuration, environment or storage. */
export type ManagedProjectGitOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  token?: string;
  assertCurrent?: () => void;
  startRun?: GitOperationStarter;
};
/** Native custody supplies this snapshot to transport; SDK callers cannot choose it. */
export type ManagedProjectTransportOptions = ManagedProjectGitOptions & {
  readonly env: NodeJS.ProcessEnv;
};
export type ManagedProjectSourceV1 = {
  resolveUrl: (url: string) => { url: string; name: string } | null;
  invalidUrlMessage: string;
  clone: (
    input: { url: string; target: string; requiredCommit?: string },
    options: ManagedProjectTransportOptions,
  ) => Promise<void>;
  ensureCommit: (
    input: { url: string; target: string; commit: string },
    options: ManagedProjectTransportOptions,
  ) => Promise<void>;
  refresh: (
    input: { url: string; target: string },
    options: ManagedProjectTransportOptions,
  ) => Promise<void>;
};
