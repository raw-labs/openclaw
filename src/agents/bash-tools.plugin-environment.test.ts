import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  activateDisabledExecutionExclusions,
  createExecutionEnvironmentFixture,
} from "../plugins/execution-environment.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { writeSecretStoreEntry } from "../secrets/store/secret-store.js";
import { createExecTool } from "./bash-tools.exec-run.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it.each([false, true])(
  "preserves native identity with plugin execution enabled=%s",
  async (enabled) => {
    const stateDir = tempDirs.make("plugin-exec-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_DISABLE_SHELL_SNAPSHOT", "1");
    vi.stubEnv("GH_TOKEN", "synthetic-native-token");
    const fixture = createExecutionEnvironmentFixture({
      id: "process",
      prepare: () => ({
        credentialScrubEnv: {},
        localIdentityEnv: { EXAMPLE_EXECUTION_LABEL: "from-plugin" },
        excludedStoreNames: [],
        wrapLocalLaunch: (argv) => [
          process.execPath,
          "-e",
          'process.env.EXAMPLE_LAUNCH_WRAPPER="wrapped"; const r=require("node:child_process").spawnSync(process.argv[1],process.argv.slice(2),{stdio:"inherit",env:process.env}); process.exit(r.status ?? 1)',
          ...argv,
        ],
      }),
    });
    if (!enabled) {
      fixture.registry.executionEnvironments = [];
    }
    const result = await fixture.run(async () => {
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        cwd: stateDir,
        pathPrepend: [path.dirname(process.execPath)],
        preparedStoreEnvironment: { env: {} },
        notifyOnExit: false,
        backgroundMs: 10_000,
      });
      return await tool.execute("plugin-env", {
        command: `${JSON.stringify(process.execPath)} -e 'console.log(process.env.EXAMPLE_EXECUTION_LABEL,process.env.EXAMPLE_LAUNCH_WRAPPER,process.env.GH_TOKEN)'`,
      });
    });
    expect(result.details.status).toBe("completed");
    expect(result.content).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining(
          enabled
            ? "from-plugin wrapped synthetic-native-token"
            : "undefined undefined synthetic-native-token",
        ),
      }),
    );
  },
);

it("withholds inherited and stored excluded credentials even without an enabled execution plugin", async () => {
  const stateDir = tempDirs.make("plugin-execution-exclusions-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("EXECUTION_EXCLUDED_VALUE", "synthetic-inherited-value");
  vi.stubEnv("EXAMPLE_ALLOWED_VALUE", "visible");
  await writeSecretStoreEntry({
    scope: { kind: "team" },
    name: "EXECUTION_EXCLUDED_STORED",
    value: "synthetic-stored-value",
    kind: "env",
    updatedBy: "test",
  });
  const config = await activateDisabledExecutionExclusions({ agents: { entries: { main: {} } } });
  const result = await withPluginRuntimeGatewayRequestScope(
    { pluginRegistry: createEmptyPluginRegistry(), isWebchatConnect: () => false },
    () =>
      createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        config,
        cwd: stateDir,
        notifyOnExit: false,
        backgroundMs: 10_000,
      }).execute("excluded-values", {
        command: `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify({inherited:process.env.EXECUTION_EXCLUDED_VALUE,stored:process.env.EXECUTION_EXCLUDED_STORED,ordinary:process.env.EXAMPLE_ALLOWED_VALUE}))'`,
      }),
  );
  expect(result.details.status).toBe("completed");
  expect(result.content).toContainEqual(
    expect.objectContaining({
      text: expect.stringContaining('{"inherited":"","stored":"","ordinary":"visible"}'),
    }),
  );
});
