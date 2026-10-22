import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { updateGitHubToolIdentityConfig } from "../../extensions/github-repositories/tool-identity-config-api.js";
import { withTempHomeCore as withTempHome } from "../plugin-sdk/test-helpers/temp-home.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

it("keeps canonical GitHub mutation inside its include and preserves identity CAS and agent sandbox policy", async () => {
  await withTempHome(
    async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const pluginPath = path.join(stateDir, "github.json5");
      await fs.mkdir(stateDir, { recursive: true });
      const previous = { profileId: "ghp_11111111111111111111111111111111", allowInSandbox: false };
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: { entries: { Build: {} } },
          plugins: {
            entries: {
              "github-repositories": { enabled: false, config: { $include: "./github.json5" } },
            },
          },
        }),
      );
      await fs.writeFile(
        pluginPath,
        JSON.stringify({
          agents: { build: previous },
          reader: { enabled: false },
          service: { host: "github.com" },
        }),
      );
      const env = { HOME: home, OPENCLAW_STATE_DIR: stateDir };
      try {
        await updateGitHubToolIdentityConfig({
          scope: "agent",
          agentId: "Build",
          expectedIdentity: previous,
          identity: { profileId: "ghp_22222222222222222222222222222222" },
        });
        const root = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(root.plugins.entries["github-repositories"]).toMatchObject({
          enabled: false,
          config: { $include: "./github.json5" },
        });
        const includedRaw = await fs.readFile(pluginPath, "utf8");
        expect(JSON.parse(includedRaw)).toMatchObject({
          agents: {
            build: { profileId: "ghp_22222222222222222222222222222222", allowInSandbox: false },
          },
          reader: { enabled: false },
          service: { host: "github.com" },
        });
        await expect(
          updateGitHubToolIdentityConfig({
            scope: "agent",
            agentId: "Build",
            expectedIdentity: previous,
            identity: { profileId: "ghp_33333333333333333333333333333333" },
          }),
        ).rejects.toThrow("GitHub identity changed");
        expect(await fs.readFile(pluginPath, "utf8")).toBe(includedRaw);
      } finally {
        await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
      }
    },
    { env: { OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json") } },
  );
});
