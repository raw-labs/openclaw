import type { OpenClawPluginServiceV2 } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { githubExecutionEnvironment } from "./execution-environment-api.js";
import { repositoryGatewayMethods } from "./gateway-methods-api.js";
export default definePluginEntry({
  id: "github-repositories",
  name: "GitHub",
  description: "GitHub accounts, Settings, and execution identity",
  register(api) {
    if (api.registrationMode === "cli-metadata") {
      return;
    }
    api.registerExecutionEnvironment(githubExecutionEnvironment);
    for (const row of repositoryGatewayMethods) {
      const [method, , scope, since] = row;
      const policy: {
        startup?: boolean;
        controlPlaneWrite?: boolean;
        advertise?: boolean;
        description?: string;
      } = row.length > 4 ? (row[4] ?? {}) : {};
      api.registerGatewayMethod(
        method,
        async (options) => {
          const runtime = await import("./runtime-api.js");
          const handler = runtime.repositoryHandlers[method];
          if (!handler) {
            throw new Error(`GitHub repository method is unavailable: ${method}`);
          }
          await handler(options);
        },
        {
          scope,
          since,
          profileAccess: method.startsWith("users.") ? "required" : "independent",
          ...(policy.startup ? { startup: "unavailable-until-sidecars" } : {}),
          ...(policy.controlPlaneWrite ? { controlPlaneWrite: true } : {}),
        },
      );
    }
    let service: OpenClawPluginServiceV2 | undefined;
    api.registerService({
      apiVersion: 2,
      id: "github-repositories.accounts",
      async start(context) {
        const { createRepositoryAccountService } = await import("./src/lifecycle.js");
        const instanceSignal = api.lifecycle.signal;
        if (!instanceSignal) {
          throw new Error("GitHub repository service requires a managed plugin instance.");
        }
        service = createRepositoryAccountService(instanceSignal);
        await service.start(context);
      },
      async stop(context) {
        await service?.stop?.(context);
        service = undefined;
      },
    });
  },
});
