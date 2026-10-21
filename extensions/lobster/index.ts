import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { parseLobsterConfig, resolveLobsterCallerId } from "./src/lobster-config.js";
import { createEmbeddedLobsterRunner } from "./src/lobster-runner.js";
import { createLobsterTool } from "./src/lobster-tool.js";

export default definePluginEntry({
  id: "lobster",
  name: "Lobster",
  description: "Durable workflows with resumable approval and input checkpoints",
  configSchema: { parse: parseLobsterConfig },
  register(api) {
    const storeOptions = parseLobsterConfig(api.pluginConfig);
    api.registerTool(
      {
        contextVersion: 2,
        create(ctx) {
          if (ctx.sandboxed) {
            return null;
          }
          return createLobsterTool({
            runner: createEmbeddedLobsterRunner({
              storeOptions,
              callerId: resolveLobsterCallerId(ctx),
              assertCurrent: ctx.assertInvocationCurrent,
            }),
          });
        },
      },
      { optional: true, workspaceAccess: "execute" },
    );
    api.on(
      "before_prompt_build",
      async (_event, ctx) => {
        const authority = ctx.toolAuthority;
        const callerId = resolveLobsterCallerId(ctx);
        if (ctx.sandboxed || !callerId || !authority?.allows("lobster")) {
          return undefined;
        }
        const assertCurrent = () => {
          authority.assertActive();
          ctx.hookInvocation?.assertActive();
        };
        const runner = createEmbeddedLobsterRunner({ storeOptions, callerId, assertCurrent });
        const result = await runner.run({
          action: "list",
          status: "waiting",
          limit: 5,
          cwd: ctx.workspaceDir ?? process.cwd(),
          timeoutMs: 2_000,
          maxStdoutBytes: 8_000,
        });
        assertCurrent();
        if (!result.ok) {
          api.logger.warn("Lobster pending-run rediscovery failed; use the lobster list action.");
          return undefined;
        }
        const page = result.output?.[0];
        if (!page || typeof page !== "object" || !("runs" in page) || !Array.isArray(page.runs)) {
          return undefined;
        }
        const ids = page.runs.flatMap((run: unknown) =>
          run &&
          typeof run === "object" &&
          "id" in run &&
          typeof run.id === "string" &&
          /^[a-zA-Z0-9_-]{1,128}$/.test(run.id)
            ? [run.id]
            : [],
        );
        if (ids.length === 0) {
          return undefined;
        }
        return {
          appendContext:
            `Lobster has pending review runs in this conversation: ${ids.join(", ")}. ` +
            "Use lobster status with runId, then review with waitId to read the saved question. " +
            "Ask the user before resuming. Use list with status waiting to discover more.",
        };
      },
      { requiresToolAuthority: true },
    );
  },
});
