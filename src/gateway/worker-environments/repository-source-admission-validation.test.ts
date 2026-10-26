import type { RepositorySourceV1 } from "openclaw/plugin-sdk/repository-sources";
import { expect, it, vi } from "vitest";
import { withTempHomeCore as withTempHome } from "../../plugin-sdk/test-helpers/temp-home.js";
import { createRepositorySourceFixture } from "../../plugins/repository-source.test-support.js";
import { createRepositorySources } from "../repository-sources.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";

const commit = "a".repeat(40);
const tree = "b".repeat(40);
const blob = "c".repeat(40);
const url = "https://git.example/team/project.git";

it.each([
  { failure: "pinned commit mismatch", expected: /immutable project facts/ },
  { failure: "invalid root tree", expected: /immutable project facts/ },
  { failure: "invalid recipe blob", expected: /identity changed/ },
  { failure: "oversized recipe bytes", expected: /size limit/ },
])("refuses source admission with $failure at the host boundary", async ({ failure, expected }) => {
  await withTempHome(async (home) => {
    const readBlob = vi.fn(async () => "é".repeat(512 * 1024 + 1));
    const source: RepositorySourceV1 = {
      id: "remote",
      resolve: (candidate) => (candidate === url ? { url, name: "project" } : undefined),
      async prepare() {
        throw new Error("Worker admission must not clone locally");
      },
      worker: {
        async prepare({ assertCurrent }) {
          return {
            repositoryId: "repository_fixture",
            identityKey: "selected-reader",
            baseCommit: commit,
            tree: failure === "invalid root tree" ? "not-a-git-object" : tree,
            assertCurrent,
            async confirmAdmission() {},
            async revalidate() {},
            async readTree() {
              return [
                {
                  path: ".devcontainer.json",
                  type: "blob" as const,
                  mode: "100644",
                  sha: failure === "invalid recipe blob" ? "not-a-git-object" : blob,
                },
              ];
            },
            readBlob,
          };
        },
        async checkout() {
          throw new Error("Source admission must not start a worker");
        },
      },
    };
    const fixture = createRepositorySourceFixture(source);
    const config = { agents: { entries: { main: { workspace: home } } } };
    const sources = createRepositorySources(new AbortController().signal, fixture.registry);
    await expect(
      prepareRepositoryWorkerProjectSource({
        namespace: "fixture",
        getConfig: () => config,
        getRepositorySources: () => sources,
        assertCurrent() {},
        repository: {
          agentId: "main",
          url,
          ...(failure === "pinned commit mismatch" ? { baseCommit: "d".repeat(40) } : {}),
        },
      }),
    ).rejects.toThrow(expected);
    expect(readBlob).toHaveBeenCalledTimes(failure === "oversized recipe bytes" ? 1 : 0);
  });
});
