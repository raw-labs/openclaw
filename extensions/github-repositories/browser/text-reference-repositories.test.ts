import type { ProjectRecord } from "@openclaw/gateway-protocol";
import { describe, expect, it } from "vitest";
import { markdownGitHubAliases, projectGitHubRepositories } from "./text-reference-repositories.ts";

const credentialOrigin = new URL("https://github.com/openclaw/clawsweeper.git");
credentialOrigin.username = "synthetic";
credentialOrigin.password = "synthetic-password";

const project: ProjectRecord = {
  id: "registered",
  displayName: "ClawSweeper",
  repoRoot: "/workspace/project",
  source: "registered",
  originUrl: "https://github.com/openclaw/clawsweeper.git",
};

describe("GitHub reference repository aliases", () => {
  it.each([
    "gitlab.com:team/shared.git",
    "[2001:db8::1]:shared.git",
    "ssh://internal/shared.git",
    "https://gitlab.com/team/%73hared.git",
  ])("keeps authorized non-GitHub basename collisions unresolved: %s", (originUrl) => {
    const repositories = projectGitHubRepositories([
      {
        ...project,
        displayName: "Public Project",
        originUrl: "https://github.com/acme/shared.git",
      },
      { ...project, id: "internal", displayName: "Internal Service", originUrl },
    ]);
    expect(markdownGitHubAliases(repositories).find(([alias]) => alias === "shared")).toEqual([
      "shared",
      null,
    ]);
  });
  it.each([
    ["github.com:OpenClaw/ClawSweeper.git", true],
    ["ssh://github.com/OpenClaw/ClawSweeper.git", true],
    ["ssh://github.com:22/OpenClaw/ClawSweeper.git", true],
    ["ssh://github.com:2222/OpenClaw/ClawSweeper.git", false],
    ["ssh://github.com.evil.test/OpenClaw/ClawSweeper.git", false],
    [credentialOrigin.href, false],
    ["git@evil.test:openclaw/clawsweeper.git", false],
    ["/workspace/clawsweeper", false],
  ])("binds only verified public GitHub clone coordinates: %s", (originUrl, resolves) => {
    expect(projectGitHubRepositories([{ ...project, originUrl }])).toEqual([
      resolves
        ? { owner: "openclaw", repo: "clawsweeper", aliases: ["ClawSweeper"] }
        : { aliases: ["ClawSweeper"] },
    ]);
  });
});
