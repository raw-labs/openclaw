import { createLazyRuntimeNamedExport } from "../shared/lazy-runtime.js";

const loadPrepareGitCoauthorAttribution = createLazyRuntimeNamedExport(
  () => import("../agents/git-coauthor-attribution.js"),
  "prepareGitCoauthorAttribution",
);
async function prepareGitCoauthorAttribution(
  ...args: Parameters<
    typeof import("../agents/git-coauthor-attribution.js").prepareGitCoauthorAttribution
  >
): Promise<
  Awaited<
    ReturnType<typeof import("../agents/git-coauthor-attribution.js").prepareGitCoauthorAttribution>
  >
> {
  const operation = await loadPrepareGitCoauthorAttribution();
  return await operation(...args);
}

const loadRestoreGitHubPublicationRequester = createLazyRuntimeNamedExport(
  () => import("./github-publication-requester.js"),
  "restoreGitHubPublicationRequester",
);
async function restoreGitHubPublicationRequester(
  ...args: Parameters<
    typeof import("./github-publication-requester.js").restoreGitHubPublicationRequester
  >
): Promise<
  Awaited<
    ReturnType<typeof import("./github-publication-requester.js").restoreGitHubPublicationRequester>
  >
> {
  const operation = await loadRestoreGitHubPublicationRequester();
  return await operation(...args);
}

const loadLoadGatewaySessionEntryReadOnlyInWorker = createLazyRuntimeNamedExport(
  () => import("./session-utils-store-worker.js"),
  "loadGatewaySessionEntryReadOnlyInWorker",
);
async function loadGatewaySessionEntryReadOnlyInWorker(
  ...args: Parameters<
    typeof import("./session-utils-store-worker.js").loadGatewaySessionEntryReadOnlyInWorker
  >
): Promise<
  Awaited<
    ReturnType<
      typeof import("./session-utils-store-worker.js").loadGatewaySessionEntryReadOnlyInWorker
    >
  >
> {
  const operation = await loadLoadGatewaySessionEntryReadOnlyInWorker();
  return await operation(...args);
}

const loadPrepareLocalWorkspaceCheckout = createLazyRuntimeNamedExport(
  () => import("./worker-environments/local-workspace-checkout.js"),
  "prepareLocalWorkspaceCheckout",
);
async function prepareLocalWorkspaceCheckout(
  ...args: Parameters<
    typeof import("./worker-environments/local-workspace-checkout.js").prepareLocalWorkspaceCheckout
  >
): Promise<
  Awaited<
    ReturnType<
      typeof import("./worker-environments/local-workspace-checkout.js").prepareLocalWorkspaceCheckout
    >
  >
> {
  const operation = await loadPrepareLocalWorkspaceCheckout();
  return await operation(...args);
}

const loadWithLocalWorkspaceProjection = createLazyRuntimeNamedExport(
  () => import("./worker-environments/local-workspace-projection.js"),
  "withLocalWorkspaceProjection",
);
async function withLocalWorkspaceProjection<T>(
  ...args: Parameters<
    typeof import("./worker-environments/local-workspace-projection.js").withLocalWorkspaceProjection<T>
  >
): Promise<
  Awaited<
    ReturnType<
      typeof import("./worker-environments/local-workspace-projection.js").withLocalWorkspaceProjection<T>
    >
  >
> {
  const operation = await loadWithLocalWorkspaceProjection();
  return await operation<T>(...args);
}

const loadWithSessionRepositoryCheckpoint = createLazyRuntimeNamedExport(
  () => import("./worker-environments/session-repository-checkpoints.js"),
  "withSessionRepositoryCheckpoint",
);
async function withSessionRepositoryCheckpoint<T>(
  ...args: Parameters<
    typeof import("./worker-environments/session-repository-checkpoints.js").withSessionRepositoryCheckpoint<T>
  >
): Promise<
  Awaited<
    ReturnType<
      typeof import("./worker-environments/session-repository-checkpoints.js").withSessionRepositoryCheckpoint<T>
    >
  >
> {
  const operation = await loadWithSessionRepositoryCheckpoint();
  return await operation<T>(...args);
}

const loadPrepareWorkerWorkspaceGitPack = createLazyRuntimeNamedExport(
  () => import("./worker-environments/workspace-git-base.js"),
  "prepareWorkerWorkspaceGitPack",
);
async function prepareWorkerWorkspaceGitPack(
  ...args: Parameters<
    typeof import("./worker-environments/workspace-git-base.js").prepareWorkerWorkspaceGitPack
  >
): Promise<
  Awaited<
    ReturnType<
      typeof import("./worker-environments/workspace-git-base.js").prepareWorkerWorkspaceGitPack
    >
  >
> {
  const operation = await loadPrepareWorkerWorkspaceGitPack();
  return await operation(...args);
}

const loadCaptureWorkspaceSnapshot = createLazyRuntimeNamedExport(
  () => import("./worker-environments/workspace-manifest-worker.js"),
  "captureWorkspaceSnapshot",
);
async function captureWorkspaceSnapshot(
  ...args: Parameters<
    typeof import("./worker-environments/workspace-manifest-worker.js").captureWorkspaceSnapshot
  >
): Promise<
  Awaited<
    ReturnType<
      typeof import("./worker-environments/workspace-manifest-worker.js").captureWorkspaceSnapshot
    >
  >
> {
  const operation = await loadCaptureWorkspaceSnapshot();
  return await operation(...args);
}

export {
  prepareGitCoauthorAttribution,
  restoreGitHubPublicationRequester,
  loadGatewaySessionEntryReadOnlyInWorker,
  prepareLocalWorkspaceCheckout,
  withLocalWorkspaceProjection,
  withSessionRepositoryCheckpoint,
  prepareWorkerWorkspaceGitPack,
  captureWorkspaceSnapshot,
};
