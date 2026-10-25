import { pluginInstanceInvocation } from "../plugins/plugin-instance-invocation.js";
import {
  getPluginInstanceOwner,
  hasCurrentPluginInstanceAuthority,
  wrapCurrentPluginInstance,
} from "../plugins/plugin-instance-scope.js";
import {
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type {
  ManagedProjectOptions,
  ManagedProjectSourceV1,
} from "../projects/managed-project-source.js";
import type { ProjectRegistryRecord } from "../projects/project-registry.types.js";

export type {
  RepositorySourceV1,
  RepositorySourceProject,
  RepositorySourcePreparation,
  RepositoryWorkerReadLease,
  RepositoryTreeEntry,
} from "../plugins/repository-source-types.js";
export {
  performRepositoryCheckout,
  type RepositoryCheckoutTransfer,
} from "../plugins/repository-checkout-transfer.js";
export type {
  ManagedProjectOptions,
  ManagedProjectSourceV1,
} from "../projects/managed-project-source.js";

/** Keep checkout leases, storage, and registration with the existing host custodian. */
export function createManagedProjectCheckoutV1(source: ManagedProjectSourceV1) {
  const invocation = (options: ManagedProjectOptions) => {
    const instance = pluginInstanceInvocation.getStore()?.instance;
    const owner = instance && getPluginInstanceOwner(instance);
    const resolveContext =
      getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext ??
      (owner && !owner.revoked ? getGatewayContextResolver(owner.registry) : undefined);
    const context = resolveContext?.();
    if (!instance || !context || !hasCurrentPluginInstanceAuthority(instance.pluginId)) {
      throw new Error("Managed repository checkout requires its live plugin and Gateway binding.");
    }
    const config = context.getRuntimeConfig();
    const assertCurrent = () => {
      if (
        !hasCurrentPluginInstanceAuthority(instance.pluginId) ||
        resolveContext?.() !== context ||
        context.getRuntimeConfig() !== config
      ) {
        throw new Error("Managed repository checkout owner changed; retry preparation.");
      }
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
    };
    assertCurrent();
    return {
      config,
      source: wrapCurrentPluginInstance(source),
      options: { signal: options.signal, timeoutMs: options.timeoutMs, assertCurrent },
    };
  };
  return {
    async materialize(
      input: { gitUrl: string; name?: string; requiredCommit?: string },
      options: ManagedProjectOptions = {},
    ): Promise<ProjectRegistryRecord> {
      const admitted = invocation(options);
      const { materializeProjectClone } = await import("../projects/project-clone.js");
      admitted.options.assertCurrent();
      return await materializeProjectClone(
        { ...input, cfg: admitted.config },
        admitted.options,
        admitted.source,
      );
    },
    async refresh(project: ProjectRegistryRecord, options: ManagedProjectOptions = {}) {
      const admitted = invocation(options);
      const { refreshProjectClone } = await import("../projects/project-clone.js");
      admitted.options.assertCurrent();
      await refreshProjectClone(project, admitted.options, admitted.source);
    },
  };
}
