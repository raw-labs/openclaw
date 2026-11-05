import { expect, it, vi } from "vitest";
import { readGitHubPublicationBaseSha } from "./publication-git-transport-api.js";

it.each([
  ["release#123", "repos/owner/repo/git/ref/heads/release%23123"],
  ["release%2F123", "repos/owner/repo/git/ref/heads/release%252F123"],
])("reads the exact base ref when branch %s contains URL syntax", async (branch, endpoint) => {
  const head = "a".repeat(40);
  const run = vi.fn<Parameters<typeof readGitHubPublicationBaseSha>[0]>(async () => ({
    code: 0,
    stdout: Buffer.from(JSON.stringify({ ref: `refs/heads/${branch}`, sha: head })),
    stderr: Buffer.alloc(0),
    signal: null,
    killed: false,
    termination: "exit",
    timeoutMs: 60_000,
  }));
  expect(await readGitHubPublicationBaseSha(run, "owner/repo", branch, "github.com", {})).toBe(
    head,
  );
  expect(run.mock.calls[0]?.[0]).toContain(endpoint);
});
