import type { RepositorySourceV1 } from "openclaw/plugin-sdk/repository-sources";
import { describe, expect, it } from "vitest";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createRepositorySourceFixture } from "../plugins/repository-source.test-support.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createRepositorySources } from "./repository-sources.js";

function source(id: string, host: string): RepositorySourceV1 {
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

describe("Gateway repository source facade", () => {
  it("selects admitted sources without owning a separate installation registry", async () => {
    const host = new AbortController();
    const fixture = createPluginRegistryFixture();
    const instances = [
      ["forge-a", "a.example"],
      ["forge-b", "b.example"],
      ["forge-c", "a.example"],
    ].map(([pluginId, hostname]) => {
      const record = createPluginRecord({
        id: pluginId!,
        repositorySources: [{ id: "repos", label: "Forge", searchMethod: "forge.search" }],
      });
      registerTestPlugin({
        ...fixture,
        record,
        register: (api) => api.registerRepositorySource(source("repos", hostname!)),
      });
      return getPluginInstance(record)!;
    });
    const registry = createRepositorySources(host.signal, fixture.registry.registry);
    try {
      expect(registry.resolve("https://b.example/team/project").id).toBe("forge-b/repos");
      expect(() => registry.resolve("https://a.example/team/project")).toThrow("Select a source");
      const selected = registry.resolve("https://a.example/team/project", "forge-a/repos");
      await instances[0]!.dispose();
      expect(() => selected.assertCurrent()).toThrow();
      host.abort();
      expect(() => registry.resolve("https://b.example/team/project")).toThrow();
    } finally {
      await Promise.all(instances.map((instance) => instance.dispose()));
    }
  });

  it("refuses a preparation from a retired plugin after a replacement is registered", async () => {
    const pending = createDeferredCore<Awaited<ReturnType<RepositorySourceV1["prepare"]>>>();
    const fixture = createRepositorySourceFixture({
      ...source("repos", "forge.example"),
      prepare: () => pending.promise,
    });
    const host = new AbortController();
    const registry = createRepositorySources(host.signal, fixture.registry);
    const preparation = registry.resolve("https://forge.example/team/project").prepare(input());
    const disposal = fixture.instance.dispose();
    const replacement = createRepositorySourceFixture(source("repos", "forge.example"));
    pending.resolve({
      project: { id: "old", repoRoot: "/synthetic/old", source: "cloned" },
      assertCurrent() {},
      async refresh() {},
    });
    await expect(preparation).rejects.toThrow();
    await disposal;
    const current = await createRepositorySources(host.signal, replacement.registry)
      .resolve("https://forge.example/team/project")
      .prepare(input());
    expect(current.project.repoRoot).toBe("/synthetic/project");
  });

  it.each(["caller", "Gateway"] as const)(
    "fences retained checkout refreshes after %s cancellation",
    async (owner) => {
      let refreshes = 0;
      const owned = source("repos", "forge.example");
      const fixture = createRepositorySourceFixture({
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
      });
      const caller = new AbortController();
      const gateway = new AbortController();
      const prepared = await createRepositorySources(gateway.signal, fixture.registry)
        .resolve("https://forge.example/team/project")
        .prepare({ ...input(), signal: caller.signal });
      (owner === "caller" ? caller : gateway).abort();
      await expect(prepared.refresh()).rejects.toThrow();
      expect(refreshes).toBe(0);
    },
  );

  it.each(["plugin", "Gateway"] as const)(
    "fences worker read callbacks across asynchronous %s retirement",
    async (owner) => {
      const blob = createDeferredCore<string>();
      let treeReads = 0;
      const fixture = createRepositorySourceFixture({
        ...source("repos", "forge.example"),
        worker: {
          async prepare() {
            return {
              repositoryId: "repository-42",
              identityKey: "anonymous-fixture",
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
              async prepareGitPack() {
                throw new Error("Unexpected Git pack request");
              },
            };
          },
          async checkout() {},
        },
      });
      const gateway = new AbortController();
      const lease = await createRepositorySources(gateway.signal, fixture.registry)
        .resolve("https://forge.example/team/project")
        .prepareWorker(input());
      const reading = lease.readBlob("c".repeat(40));
      const disposal =
        owner === "plugin" ? fixture.instance.dispose() : Promise.resolve(gateway.abort());
      blob.resolve("data from retired owner");
      await expect(reading).rejects.toThrow();
      await disposal;
      await expect(lease.readTree("b".repeat(40))).rejects.toThrow();
      expect(treeReads).toBe(0);
    },
  );
});
