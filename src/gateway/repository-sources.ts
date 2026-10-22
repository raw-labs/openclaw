import type { RepositoryWorkerSource } from "./repository-worker-source-contract.js";
/** A source owns URL admission and credentials; sessions retain workspace mutation authority. */
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
export type RepositorySource = {
  /** Qualified plugin/contribution identifier from the admitted manifest. */
  id: string;
  worker?: RepositoryWorkerSource;
  resolve: (url: string) => { url: string; name: string } | undefined;
  prepare: (input: {
    url: string;
    agentId: string;
    signal: AbortSignal;
    assertCurrent: () => void;
  }) => Promise<RepositorySourcePreparation>;
};

export function createRepositorySources(lifetimeSignal: AbortSignal) {
  const sources = new Map<string, { source: RepositorySource; signal: AbortSignal }>();
  return {
    install(source: RepositorySource, lifetime: AbortSignal) {
      lifetimeSignal.throwIfAborted();
      lifetime.throwIfAborted();
      if (!/^[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._-]{0,127}$/u.test(source.id)) {
        throw new Error("Repository source requires a qualified plugin/contribution ID.");
      }
      if (sources.has(source.id)) {
        throw new Error(`Repository source already installed: ${source.id}`);
      }
      const owned = { source, signal: lifetime };
      sources.set(source.id, owned);
      const remove = () => {
        if (sources.get(source.id) === owned) {
          sources.delete(source.id);
        }
        lifetime.removeEventListener("abort", remove);
      };
      lifetime.addEventListener("abort", remove, { once: true });
      return remove;
    },
    resolve(url: string, sourceId?: string) {
      lifetimeSignal.throwIfAborted();
      const matches = [...sources.values()].flatMap((owned) => {
        if (owned.signal.aborted || (sourceId && owned.source.id !== sourceId)) {
          return [];
        }
        const resolved = owned.source.resolve(url);
        return resolved ? [{ owned, resolved }] : [];
      });
      if (matches.length !== 1) {
        throw new Error(
          matches.length === 0
            ? "No enabled repository source accepts this URL. Enable its plugin or choose another source."
            : "Several repository sources accept this URL. Select a source explicitly.",
        );
      }
      const { owned, resolved } = matches[0]!;
      const assertSource = () => {
        lifetimeSignal.throwIfAborted();
        owned.signal.throwIfAborted();
        if (sources.get(owned.source.id) !== owned) {
          throw new Error("Repository source changed; select it again.");
        }
        const current = owned.source.resolve(url);
        if (!current || current.url !== resolved.url) {
          throw new Error("Repository source changed; select it again.");
        }
      };
      return {
        id: owned.source.id,
        ...resolved,
        assertCurrent: assertSource,
        isWorkerIdentityCurrent(input: Parameters<RepositoryWorkerSource["isIdentityCurrent"]>[0]) {
          const worker = owned.source.worker;
          if (!worker) {
            return false;
          }
          assertSource();
          const current = worker.isIdentityCurrent(input);
          assertSource();
          return current;
        },
        async restoreWorker(input: Omit<Parameters<RepositoryWorkerSource["restore"]>[0], "url">) {
          const worker = owned.source.worker;
          if (!worker) {
            throw new Error("This repository source does not support Gateway restoration.");
          }
          const assertCurrent = () => {
            assertSource();
            input.signal?.throwIfAborted();
            input.assertCurrent();
          };
          assertCurrent();
          const restored = await worker.restore({ ...input, url: resolved.url, assertCurrent });
          const assertRestored = () => {
            assertCurrent();
            restored.assertCurrent();
          };
          assertRestored();
          return {
            project: structuredClone(restored.project),
            assertCurrent: assertRestored,
            async readRemoteHead(branch: string) {
              assertRestored();
              const head = await restored.readRemoteHead(branch);
              assertRestored();
              return head;
            },
          };
        },
        async prepareWorker(input: Omit<Parameters<RepositoryWorkerSource["prepare"]>[0], "url">) {
          const worker = owned.source.worker;
          if (!worker) {
            throw new Error("This repository source does not support worker preparation.");
          }
          const assertCurrent = () => {
            assertSource();
            input.assertCurrent();
          };
          const assertAdmission = () => {
            assertCurrent();
            input.signal?.throwIfAborted();
            input.assertAdmission?.();
          };
          assertAdmission();
          const lease = await worker.prepare({
            ...input,
            url: resolved.url,
            assertCurrent,
            assertAdmission,
          });
          const assertLease = () => {
            assertCurrent();
            lease.assertCurrent();
          };
          assertAdmission();
          assertLease();
          const prepareGitPack = lease.prepareGitPack;
          return {
            url: lease.url,
            repositoryId: lease.repositoryId,
            identity: structuredClone(lease.identity),
            private: lease.private,
            baseCommit: lease.baseCommit,
            tree: lease.tree,
            assertCurrent: assertLease,
            async confirmAdmission() {
              assertAdmission();
              await lease.confirmAdmission();
              assertAdmission();
              assertLease();
            },
            async revalidate(signal?: AbortSignal) {
              assertLease();
              signal?.throwIfAborted();
              await lease.revalidate(signal);
              assertLease();
              signal?.throwIfAborted();
            },
            async readTree(sha: string, signal?: AbortSignal) {
              assertLease();
              signal?.throwIfAborted();
              const entries = await lease.readTree(sha, signal);
              assertLease();
              signal?.throwIfAborted();
              return entries;
            },
            async readBlob(sha: string, signal?: AbortSignal) {
              assertLease();
              signal?.throwIfAborted();
              const blob = await lease.readBlob(sha, signal);
              assertLease();
              signal?.throwIfAborted();
              return blob;
            },
            ...(prepareGitPack
              ? {
                  async prepareGitPack(packInput: Parameters<typeof prepareGitPack>[0]) {
                    assertLease();
                    packInput.signal.throwIfAborted();
                    const pack = await prepareGitPack(packInput);
                    assertLease();
                    packInput.signal.throwIfAborted();
                    return pack;
                  },
                }
              : {}),
          };
        },
        async checkoutWorker(input: Parameters<RepositoryWorkerSource["checkout"]>[0]) {
          const worker = owned.source.worker;
          if (!worker) {
            throw new Error("This repository source does not support worker checkout.");
          }
          const assertCurrent = () => {
            assertSource();
            input.assertCurrent();
          };
          assertCurrent();
          await worker.checkout({ ...input, assertCurrent });
          assertCurrent();
        },
        async prepare(input: { agentId: string; signal: AbortSignal; assertCurrent: () => void }) {
          const assertCurrent = () => {
            assertSource();
            input.signal.throwIfAborted();
            input.assertCurrent();
          };
          assertCurrent();
          const result = await owned.source.prepare({ ...input, url: resolved.url, assertCurrent });
          assertCurrent();
          return {
            project: result.project,
            assertCurrent() {
              assertCurrent();
              result.assertCurrent();
            },
            async refresh() {
              assertCurrent();
              result.assertCurrent();
              await result.refresh();
              assertCurrent();
              result.assertCurrent();
            },
          };
        },
      };
    },
  };
}
export type RepositorySources = ReturnType<typeof createRepositorySources>;
