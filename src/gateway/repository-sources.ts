/** Gateway lifetime binding over the admitted plugin registry, not a second source owner. */
import type { PluginRegistry } from "../plugins/registry-types.js";
import { resolvePluginRepositorySource } from "../plugins/repository-sources.js";

export function createRepositorySources(signal: AbortSignal, registry?: PluginRegistry) {
  return {
    resolve(url: string, sourceId?: string) {
      signal.throwIfAborted();
      return resolvePluginRepositorySource(sourceId, url, registry, () => signal.throwIfAborted());
    },
  };
}
export type RepositorySources = ReturnType<typeof createRepositorySources>;
