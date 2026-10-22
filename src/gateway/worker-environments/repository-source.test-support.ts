import { onTestFinished } from "vitest";
import { createGitHubRepositorySource } from "../../../extensions/github-repositories/repository-source-api.js";
import { readRuntimeConfig } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { performRepositoryCheckout } from "../repository-checkout-transfer.js";
import { createRepositorySources } from "../repository-sources.js";
import type { GatewayRequestContext } from "../server-methods/types.js";

/** Real source admission and lifetime wrappers; individual suites substitute only transport I/O. */
export function createRepositorySourcesFixture(
  getConfig: () => OpenClawConfig = readRuntimeConfig,
) {
  const lifetime = new AbortController();
  const sources = createRepositorySources(lifetime.signal);
  sources.install(
    createGitHubRepositorySource(getConfig, async () => {}),
    lifetime.signal,
  );
  onTestFinished(() => lifetime.abort());
  return sources;
}

/** Local-origin fixtures exercise settlement without asking a vendor source to admit file URLs. */
export function createLocalRepositorySourcesFixture() {
  const lifetime = new AbortController();
  const sources = createRepositorySources(lifetime.signal);
  const unsupported = async (): Promise<never> => {
    throw new Error("Local fixture supports checkout only");
  };
  sources.install(
    {
      id: "fixture/local",
      resolve(url) {
        return url.startsWith("file:") ? { url, name: "local fixture" } : undefined;
      },
      prepare: unsupported,
      worker: {
        isIdentityCurrent: ({ identity }) => identity.source === "anonymous",
        prepare: unsupported,
        restore: unsupported,
        async checkout({ transfer, assertCurrent }) {
          await performRepositoryCheckout(transfer, {
            assertCurrent,
            start: async (run) => await run(),
          });
        },
      },
    },
    lifetime.signal,
  );
  onTestFinished(() => lifetime.abort());
  return sources;
}

/** Supported invocation binding for direct source caller tests, not authenticated-server proof. */
export function withRepositorySourceGatewayFixture<T>(
  getConfig: () => OpenClawConfig,
  run: (sources: ReturnType<typeof createRepositorySourcesFixture>) => Promise<T>,
): Promise<T> {
  const sources = createRepositorySourcesFixture(getConfig);
  const context = {
    getRuntimeConfig: getConfig,
    repositorySources: sources,
  } as GatewayRequestContext;
  context.resolveGatewayContext = () => context;
  return withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, () => run(sources));
}
