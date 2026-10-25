import type { PluginRegistry } from "./registry-types.js";
import { normalizePluginRepositoryUrl } from "./repository-source-url.js";
import { getActivePluginRegistry } from "./runtime.js";
import { getPluginRegistryForContext } from "./runtime/gateway-request-scope.js";
export { normalizePluginRepositoryUrl } from "./repository-source-url.js";

const SourceId = /^[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._-]{0,127}$/u;

/** Explicit selection never falls through to another plugin or the native source. */
export function resolvePluginRepositorySource(
  sourceId: string,
  url: string,
  registry: PluginRegistry | null | undefined = getPluginRegistryForContext() ??
    getActivePluginRegistry(),
) {
  if (!SourceId.test(sourceId) || !normalizePluginRepositoryUrl(url)) {
    throw new Error("Select a supported repository URL with its repository source.");
  }
  const entry = registry?.repositorySources.find(
    ({ pluginId, provider }) => `${pluginId}/${provider.id}` === sourceId,
  );
  if (!entry) {
    throw new Error("The selected repository source is unavailable. Enable its plugin and retry.");
  }
  entry.assertCurrent();
  const resolved = entry.provider.resolve(url);
  if (!resolved || !normalizePluginRepositoryUrl(resolved.url)) {
    throw new Error("The selected repository source does not accept this URL.");
  }
  const assertCurrent = () => entry.assertCurrent();
  return {
    id: sourceId,
    url: resolved.url,
    assertCurrent,
    async prepare(input: Omit<Parameters<typeof entry.provider.prepare>[0], "url">) {
      const assertSourceCurrent = () => {
        assertCurrent();
        input.signal?.throwIfAborted();
        input.assertCurrent();
      };
      assertSourceCurrent();
      const prepared = await entry.provider.prepare({
        ...input,
        url: resolved.url,
        assertCurrent: assertSourceCurrent,
      });
      assertSourceCurrent();
      const assertPrepared = () => {
        assertSourceCurrent();
        prepared.assertCurrent();
      };
      assertPrepared();
      return {
        project: prepared.project,
        assertCurrent: assertPrepared,
        async refresh() {
          assertPrepared();
          await prepared.refresh();
          assertPrepared();
        },
      };
    },
    async prepareWorker(
      input: Omit<Parameters<NonNullable<typeof entry.provider.worker>["prepare"]>[0], "url">,
    ) {
      const worker = entry.provider.worker;
      if (!worker) {
        throw new Error("The selected repository source does not support cloud preparation.");
      }
      const assertSourceCurrent = () => {
        assertCurrent();
        input.assertCurrent();
      };
      input.signal?.throwIfAborted();
      assertSourceCurrent();
      const prepared = await worker.prepare({
        ...input,
        url: resolved.url,
        assertCurrent: assertSourceCurrent,
      });
      input.signal?.throwIfAborted();
      assertSourceCurrent();
      return prepared;
    },
    async checkoutWorker(
      input: Omit<Parameters<NonNullable<typeof entry.provider.worker>["checkout"]>[0], "url">,
    ) {
      const worker = entry.provider.worker;
      if (!worker) {
        throw new Error("The selected repository source does not support cloud checkout.");
      }
      const assertSourceCurrent = () => {
        assertCurrent();
        input.assertCurrent();
      };
      assertSourceCurrent();
      await worker.checkout({ ...input, url: resolved.url, assertCurrent: assertSourceCurrent });
      assertSourceCurrent();
    },
  };
}
