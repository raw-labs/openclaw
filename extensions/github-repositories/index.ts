import type { OpenClawPluginServiceV2 } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { captureRepositoryServiceHost } from "openclaw/plugin-sdk/repository-session-host";
import { registerGitHubAgentTools } from "./agent-tools-api.js";
import { registerGitHubBoardBinding } from "./board-binding-api.js";
import { readGitHubConfig } from "./config-api.js";
import { GitHubPluginConfigSchema } from "./config-schema-api.js";
import { githubExecutionEnvironment } from "./execution-environment-api.js";
import { repositoryGatewayMethods } from "./gateway-methods-api.js";
import { createGitHubRepositorySource } from "./repository-source-api.js";
export default definePluginEntry({
  id: "github-repositories",
  name: "GitHub",
  description: "GitHub accounts, Settings, and execution identity",
  configSchema: { parse: (value: unknown) => GitHubPluginConfigSchema.parse(value) },
  register(api) {
    if (api.registrationMode === "cli-metadata") {
      return;
    }
    const config = readGitHubConfig(api.config);
    GitHubPluginConfigSchema.parse({ host: config.host, apiBaseUrl: config.apiBaseUrl });
    api.registerExecutionEnvironment(githubExecutionEnvironment);
    registerGitHubAgentTools(api);
    const repositoryConfig = () => {
      const host = captureRepositoryServiceHost();
      if (!host) {
        throw new Error("GitHub repository source requires an admitted Gateway binding.");
      }
      host.assertCurrent();
      return host.getConfig();
    };
    api.registerRepositorySource(
      createGitHubRepositorySource(repositoryConfig, async (agentId) => {
        const host = captureRepositoryServiceHost();
        if (!host) {
          throw new Error("GitHub repository source requires an admitted Gateway binding.");
        }
        host.assertCurrent();
        const { requestCurrentGitHubOAuthRefresh } = await import("./account-runtime-api.js");
        await requestCurrentGitHubOAuthRefresh(agentId);
        host.assertCurrent();
      }),
    );
    registerGitHubBoardBinding(api);
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
          profileAccess:
            method.startsWith("users.") || method.startsWith("projects.")
              ? "required"
              : "independent",
          ...(policy.startup ? { startup: "unavailable-until-sidecars" } : {}),
          ...(policy.controlPlaneWrite ? { controlPlaneWrite: true } : {}),
          ...(policy.advertise === false ? { advertise: false } : {}),
          ...(policy.description ? { description: policy.description } : {}),
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
