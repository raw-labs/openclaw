/** Vendor-neutral repository facts; credentials remain with the source implementation. */
export type RepositorySourceProject = {
  id: string;
  repoRoot: string;
  source: "cloned" | "registered" | "workspace";
};

export type RepositorySourcePreparation = {
  project: RepositorySourceProject;
  assertCurrent: () => void;
  refresh: () => Promise<void>;
};

export type RepositoryTreeEntry = {
  path: string;
  type: "tree" | "blob";
  mode: string;
  sha: string;
};

export type RepositoryWorkerReadLease = {
  repositoryId: string;
  /** Opaque, nonsecret cache partition. Never evidence of current access. */
  identityKey: string;
  baseCommit: string;
  tree: string;
  assertCurrent: () => void;
  confirmAdmission: () => Promise<void>;
  revalidate: (signal?: AbortSignal) => Promise<void>;
  readTree: (sha: string, signal?: AbortSignal) => Promise<RepositoryTreeEntry[]>;
  readBlob: (sha: string, signal?: AbortSignal) => Promise<string>;
  /** Sources own authentication; the native worker pack owner consumes the resulting file. */
  prepareGitPack: (input: {
    temporaryRoot: string;
    signal: AbortSignal;
    assertCurrent: () => void;
  }) => Promise<string>;
};

export type RepositorySourceV1 = {
  /** Local contribution ID declared by this plugin's manifest. */
  id: string;
  resolve: (url: string) => { url: string; name: string } | undefined;
  prepare: (input: {
    url: string;
    agentId: string;
    requiredCommit?: string;
    signal?: AbortSignal;
    assertCurrent: () => void;
  }) => Promise<RepositorySourcePreparation>;
  worker?: {
    prepare: (input: {
      url: string;
      agentId: string;
      ref?: string;
      baseCommit?: string;
      expected?: { repositoryId: string; identityKey: string };
      signal?: AbortSignal;
      assertCurrent: () => void;
    }) => Promise<RepositoryWorkerReadLease>;
    checkout: (input: {
      url: string;
      agentId: string;
      transfer: import("./repository-checkout-transfer.js").RepositoryCheckoutTransfer;
      assertCurrent: () => void;
    }) => Promise<void>;
  };
};
