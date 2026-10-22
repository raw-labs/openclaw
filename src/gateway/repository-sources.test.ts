import { describe, expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createRepositorySources, type RepositorySource } from "./repository-sources.js";

function source(id: string, host: string): RepositorySource {
  return {
    id,
    resolve(raw) {
      const url = URL.parse(raw);
      return url?.hostname === host ? { url: url.href, name: "team/project" } : undefined;
    },
    async prepare(input) {
      input.assertCurrent();
      return {
        project: { id: "project", repoRoot: "/synthetic/project", source: "cloned" },
        assertCurrent: input.assertCurrent,
        async refresh() {
          input.assertCurrent();
        },
      };
    },
  };
}
const input = () => ({ agentId: "main", signal: new AbortController().signal, assertCurrent() {} });

describe("repository source custody", () => {
  it("selects independent sources and retains an explicit owner when URL admission overlaps", () => {
    const host = new AbortController();
    const registry = createRepositorySources(host.signal);
    const first = new AbortController();
    registry.install(source("forge-a/repos", "a.example"), first.signal);
    registry.install(source("forge-b/repos", "b.example"), host.signal);
    expect(registry.resolve("https://a.example/team/project").id).toBe("forge-a/repos");
    expect(registry.resolve("https://b.example/team/project").id).toBe("forge-b/repos");
    registry.install(source("forge-c/repos", "a.example"), host.signal);
    expect(() => registry.resolve("https://a.example/team/project")).toThrow("Select a source");
    const selected = registry.resolve("https://a.example/team/project", "forge-a/repos");
    first.abort();
    expect(() => selected.assertCurrent()).toThrow();
    expect(() => registry.resolve("https://a.example/team/project", "forge-a/repos")).toThrow(
      "No enabled repository source",
    );
    expect(registry.resolve("https://a.example/team/project").id).toBe("forge-c/repos");
    host.abort();
    expect(() => registry.resolve("https://b.example/team/project")).toThrow();
  });

  it("rejects a preparation retired during an await even after the same ID is reinstalled", async () => {
    const host = new AbortController();
    const registry = createRepositorySources(host.signal);
    const lifetime = new AbortController();
    const pending = createDeferredCore<Awaited<ReturnType<RepositorySource["prepare"]>>>();
    registry.install(
      { ...source("forge/repos", "forge.example"), prepare: () => pending.promise },
      lifetime.signal,
    );
    const preparation = registry.resolve("https://forge.example/team/project").prepare(input());
    lifetime.abort();
    registry.install(source("forge/repos", "forge.example"), host.signal);
    pending.resolve({
      project: { id: "old", repoRoot: "/synthetic/old", source: "cloned" },
      assertCurrent() {},
      async refresh() {},
    });
    await expect(preparation).rejects.toThrow();
    const current = await registry.resolve("https://forge.example/team/project").prepare(input());
    expect(current.project.repoRoot).toBe("/synthetic/project");
  });

  it("fences retained checkout refreshes before new effects", async () => {
    const host = new AbortController();
    const registry = createRepositorySources(host.signal);
    let refreshes = 0;
    const owned = source("forge/repos", "forge.example");
    registry.install(
      {
        ...owned,
        async prepare(value) {
          const result = await owned.prepare(value);
          return {
            ...result,
            async refresh() {
              refreshes++;
            },
          };
        },
      },
      host.signal,
    );
    const caller = new AbortController();
    const prepared = await registry
      .resolve("https://forge.example/team/project")
      .prepare({ ...input(), signal: caller.signal });
    caller.abort();
    await expect(prepared.refresh()).rejects.toThrow();
    expect(refreshes).toBe(0);
  });

  it("fences worker read leases across asynchronous reads and service retirement", async () => {
    const host = new AbortController();
    const lifetime = new AbortController();
    const registry = createRepositorySources(host.signal);
    const blob = createDeferredCore<string>();
    let treeReads = 0;
    registry.install(
      {
        ...source("forge/repos", "forge.example"),
        worker: {
          async prepare() {
            return {
              url: "https://forge.example/team/project",
              repositoryId: "repository-42",
              identity: { source: "anonymous" },
              private: false,
              baseCommit: "a".repeat(40),
              tree: "b".repeat(40),
              assertCurrent() {},
              async confirmAdmission() {},
              async revalidate() {},
              async readTree() {
                treeReads++;
                return [];
              },
              readBlob: () => blob.promise,
            };
          },
          isIdentityCurrent() {
            return true;
          },
          async restore() {
            throw new Error("Unexpected Gateway restoration");
          },
          async checkout() {},
        },
      },
      lifetime.signal,
    );
    const lease = await registry
      .resolve("https://forge.example/team/project")
      .prepareWorker(input());
    const reading = lease.readBlob("c".repeat(40));
    lifetime.abort();
    blob.resolve("data from retired owner");
    await expect(reading).rejects.toThrow();
    await expect(lease.readTree("b".repeat(40))).rejects.toThrow();
    expect(treeReads).toBe(0);
  });
});
