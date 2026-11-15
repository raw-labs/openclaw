import type { PluginsControlUiCatalog } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { createApplicationConfigCapability } from "../app/config.ts";
import type { ApplicationContext } from "../app/context.ts";
import { ControlUiPluginRuntime } from "./control-ui-runtime.ts";

export const localGateway = () => location.origin.replace(/^http/u, "ws");
export const assetPath = (revision = "one", base = "") =>
  `${base}/__openclaw__/plugins/control-ui/review/${revision}/`;
export const catalog = (plugins: PluginsControlUiCatalog["plugins"], revision = "catalog") => ({
  plugins,
  revision,
  diagnostics: [],
});
const runtimes: ControlUiPluginRuntime[] = [];
export function trackTestRuntime(runtime: ControlUiPluginRuntime) {
  runtimes.push(runtime);
  return runtime;
}
export const runtimeFor = (context: ApplicationContext) =>
  trackTestRuntime(new ControlUiPluginRuntime(() => context));
export const configForRuntime = (
  refresh: () => Promise<
    Pick<ApplicationContext["config"]["current"], "pluginAssetsRequireAuth" | "pluginFrameGrants">
  > = async () => ({
    pluginAssetsRequireAuth: false,
    pluginFrameGrants: [],
  }),
  resourceBasePath = "",
) => ({ ...createApplicationConfigCapability({ resourceBasePath }), refresh });
export function connectedContext(
  client: { gatewayUrl: string; request: (method: string, params: unknown) => unknown } | undefined,
  configuration:
    | ReturnType<typeof configForRuntime>
    | ApplicationContext["config"] = configForRuntime(),
  resourceBasePath = "",
  advertised = ["plugins.controlUi.list"],
) {
  // SAFETY: the runtime reads only these gateway and config services.
  return {
    resourceBasePath,
    config: configuration,
    gateway: {
      snapshot: client
        ? {
            phase: "connected",
            client,
            hello: {
              features: { methods: advertised },
              auth: { role: "operator", scopes: ["operator.admin"] },
            },
          }
        : { phase: "connecting" },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    },
  } as unknown as ApplicationContext;
}
export const pluginDescriptor = (revision = "one", entryUrl = "/review.js") => ({
  pluginId: "review",
  name: "Review",
  revision,
  entryUrl,
  styles: [],
});
export const diagnostic = (message: string, pluginId = "review") => ({ pluginId, message });
/** Each test file retires the runtimes it started. */
export function disposeTestRuntimes() {
  for (const runtime of runtimes.splice(0)) {
    runtime.dispose();
  }
}
