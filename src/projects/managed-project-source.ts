export type ManagedProjectOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  assertCurrent?: () => void;
};

/** Native custody supplies environment; source adapters own remote admission and transport. */
export type ManagedProjectSourceV1 = {
  resolveUrl: (url: string) => { url: string; name: string } | null;
  invalidUrlMessage: string;
  clone: (
    input: { url: string; target: string; requiredCommit?: string },
    options: ManagedProjectOptions & { readonly env: NodeJS.ProcessEnv },
  ) => Promise<void>;
  ensureCommit: (
    input: { url: string; target: string; commit: string },
    options: ManagedProjectOptions & { readonly env: NodeJS.ProcessEnv },
  ) => Promise<void>;
  refresh: (
    input: { url: string; target: string },
    options: ManagedProjectOptions & { readonly env: NodeJS.ProcessEnv },
  ) => Promise<void>;
};
