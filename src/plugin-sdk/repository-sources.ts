import type { RepositorySource } from "../gateway/repository-sources.js";
import { pluginInstanceInvocation } from "../plugins/plugin-instance-invocation.js";
import {
  hasCurrentPluginInstanceAuthority,
  getPluginInstance,
  getPluginInstanceOwner,
  wrapCurrentPluginInstance,
} from "../plugins/plugin-instance-scope.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { getGatewayServiceLifetime } from "../plugins/runtime/gateway-service-owner.js";
import { getPluginServiceSchedulerBinding } from "../plugins/service-scheduler-binding.js";
import type {
  ManagedProjectGitOptions,
  ManagedProjectSourceV1,
} from "../projects/project-clone-contract.js";
import type { ProjectRegistryRecord } from "../projects/project-registry.types.js";
import { captureRepositoryServiceHost } from "./repository-session-host.js";
export type {
  RepositorySource,
  RepositorySourcePreparation,
  RepositorySourceProject,
} from "../gateway/repository-sources.js";

/** Install only for an active plugin service; the host fences every retained preparation. */
export function installRepositorySource(source: RepositorySource): () => void {
  const scheduler = getPluginServiceSchedulerBinding()?.();
  const resolveGatewayContext = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const context = resolveGatewayContext?.();
  if (!scheduler || !resolveGatewayContext || !context?.repositorySources) {
    throw new Error("Repository source installation requires a bound Gateway plugin service.");
  }
  const gatewaySignal = getGatewayServiceLifetime({ resolveGatewayContext });
  const instance = pluginInstanceInvocation.getStore()?.instance;
  const pluginId = instance?.pluginId;
  const owner = instance && getPluginInstanceOwner(instance);
  const record = owner && !owner.revoked ? owner.record : undefined;
  const managedInstance = record && getPluginInstance(record);
  const localId = source.id.slice((pluginId?.length ?? 0) + 1);
  if (
    !pluginId ||
    !instance ||
    !managedInstance ||
    managedInstance !== instance ||
    !hasCurrentPluginInstanceAuthority(pluginId) ||
    !source.id.startsWith(`${pluginId}/`) ||
    !record?.repositorySources?.some((candidate) => candidate.id === localId)
  ) {
    throw new Error(
      "Repository source requires its live plugin service and declared manifest contribution.",
    );
  }
  const signal = AbortSignal.any([scheduler.signal, gatewaySignal, instance.lifecycle.signal]);
  signal.throwIfAborted();
  managedInstance.admitFactory(source.prepare, ["assertCurrent", "refresh"]);
  if (source.worker) {
    managedInstance.admitFactory(source.worker.prepare, [
      "assertCurrent",
      "confirmAdmission",
      "revalidate",
      "readTree",
      "readBlob",
      "prepareGitPack",
    ]);
    managedInstance.admitFactory(source.worker.restore, ["assertCurrent", "readRemoteHead"]);
  }
  return context.repositorySources.install(wrapCurrentPluginInstance(source), signal);
}

export type {
  RepositoryWorkerSource,
  RepositoryWorkerReadLease,
  RepositoryWorkerRestoration,
  RepositoryReadIdentityFacts,
  RepositoryTreeEntry,
} from "../gateway/repository-worker-source-contract.js";
export {
  performRepositoryCheckout,
  type RepositoryCheckoutTransfer,
} from "../gateway/repository-checkout-transfer.js";

/** The native pack owner is loaded only for an admitted private-repository preparation. */
export async function prepareRepositoryCheckoutPack(
  ...args: Parameters<
    typeof import("../gateway/worker-environments/repository-git-pack.js").prepareRepositoryCheckoutPack
  >
) {
  return await (
    await import("../gateway/worker-environments/repository-git-pack.js")
  ).prepareRepositoryCheckoutPack(...args);
}

export type {
  ManagedProjectGitOptions,
  ManagedProjectTransportOptions,
  ManagedProjectSourceV1,
} from "../projects/project-clone-contract.js";

/** Bind host config at invocation; plugins cannot select state/config/env or retain a cold store. */
export function createManagedProjectCheckoutV1(source: ManagedProjectSourceV1) {
  const invocation = (options: ManagedProjectGitOptions) => {
    const host = captureRepositoryServiceHost();
    if (!host) {
      throw new Error("Managed repository checkout requires an admitted Gateway binding.");
    }
    const config = host.getConfig();
    const assertCurrent = () => {
      host.assertCurrent();
      options.assertCurrent?.();
      if (host.getConfig() !== config) {
        throw new Error("Managed repository configuration changed; retry the checkout.");
      }
    };
    assertCurrent();
    return {
      config,
      options: {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        token: options.token,
        startRun: options.startRun,
        assertCurrent,
      },
    };
  };
  return {
    async materialize(
      this: void,
      input: { gitUrl: string; name?: string; requiredCommit?: string },
      options: ManagedProjectGitOptions = {},
    ): Promise<ProjectRegistryRecord> {
      const admitted = invocation(options);
      const { createManagedProjectCheckoutV1: create } =
        await import("../projects/project-clone.js");
      admitted.options.assertCurrent();
      return await create(source).materialize({ ...input, cfg: admitted.config }, admitted.options);
    },
    async refresh(
      this: void,
      project: ProjectRegistryRecord,
      options: ManagedProjectGitOptions = {},
    ): Promise<void> {
      const admitted = invocation(options);
      const { createManagedProjectCheckoutV1: create } =
        await import("../projects/project-clone.js");
      admitted.options.assertCurrent();
      await create(source).refresh(project, admitted.options);
    },
  };
}
