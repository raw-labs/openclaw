import type { RepositoryCheckoutTransfer } from "./repository-checkout-transfer.js";
import type { RepositorySourceProject } from "./repository-sources.js";

/** Recorded account selection is a cache partition, never live credential authority. */
export type RepositoryReadIdentityFacts =
  | { source: "anonymous" }
  | { source: "system-detected"; accountId: number }
  | { source: "system-configured" | "agent-override"; accountId: number; profileId: string };
export type RepositoryTreeEntry = {
  path: string;
  type: "tree" | "blob";
  mode: string;
  sha: string;
};
export type RepositoryWorkerReadLease = {
  url: string;
  repositoryId: string;
  identity: RepositoryReadIdentityFacts;
  private: boolean;
  baseCommit: string;
  tree: string;
  assertCurrent: () => void;
  /** Confirm source access after the host has resolved immutable recipe facts. */
  confirmAdmission: () => Promise<void>;
  revalidate: (signal?: AbortSignal) => Promise<void>;
  readTree: (sha: string, signal?: AbortSignal) => Promise<RepositoryTreeEntry[]>;
  readBlob: (sha: string, signal?: AbortSignal) => Promise<string>;
  prepareGitPack?: (input: { temporaryRoot: string; signal: AbortSignal }) => Promise<string>;
};
export type RepositoryWorkerRestoration = {
  project: RepositorySourceProject;
  assertCurrent: () => void;
  readRemoteHead: (branch: string) => Promise<string | undefined>;
};
export type RepositoryWorkerSource = {
  isIdentityCurrent(
    this: void,
    input: { agentId: string; identity: RepositoryReadIdentityFacts },
  ): boolean;
  restore(
    this: void,
    input: {
      url: string;
      agentId: string;
      requiredCommit: string;
      signal?: AbortSignal;
      assertCurrent: () => void;
    },
  ): Promise<RepositoryWorkerRestoration>;
  prepare(
    this: void,
    input: {
      url: string;
      agentId: string;
      ref?: string;
      baseCommit?: string;
      expected?: { repositoryId: string; identity: RepositoryReadIdentityFacts };
      /** Request cancellation fences admission only; the returned lease keeps stable source authority. */
      assertAdmission?: () => void;
      signal?: AbortSignal;
      assertCurrent: () => void;
    },
  ): Promise<RepositoryWorkerReadLease>;
  checkout(
    this: void,
    input: {
      agentId: string;
      transfer: RepositoryCheckoutTransfer;
      assertCurrent: () => void;
    },
  ): Promise<void>;
};
