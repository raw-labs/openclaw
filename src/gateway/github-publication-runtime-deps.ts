// Keep transaction dependencies lazy without retaining a second policy implementation.
export async function prepareGitCoauthorAttribution(
  ...args: Parameters<
    typeof import("../agents/git-coauthor-attribution.js").prepareGitCoauthorAttribution
  >
) {
  return await (
    await import("../agents/git-coauthor-attribution.js")
  ).prepareGitCoauthorAttribution(...args);
}

export async function restoreGitHubPublicationRequester(
  ...args: Parameters<
    typeof import("./github-publication-requester.js").restoreGitHubPublicationRequester
  >
) {
  return await (
    await import("./github-publication-requester.js")
  ).restoreGitHubPublicationRequester(...args);
}

export async function loadGatewaySessionEntryReadOnlyInWorker(
  ...args: Parameters<
    typeof import("./session-utils-store-worker.js").loadGatewaySessionEntryReadOnlyInWorker
  >
) {
  return await (
    await import("./session-utils-store-worker.js")
  ).loadGatewaySessionEntryReadOnlyInWorker(...args);
}

export async function prepareLocalWorkspaceCheckout(
  ...args: Parameters<
    typeof import("./worker-environments/local-workspace-checkout.js").prepareLocalWorkspaceCheckout
  >
) {
  return await (
    await import("./worker-environments/local-workspace-checkout.js")
  ).prepareLocalWorkspaceCheckout(...args);
}

export async function withLocalWorkspaceProjection<T>(
  ...args: Parameters<
    typeof import("./worker-environments/local-workspace-projection.js").withLocalWorkspaceProjection<T>
  >
) {
  return await (
    await import("./worker-environments/local-workspace-projection.js")
  ).withLocalWorkspaceProjection<T>(...args);
}

export async function withSessionRepositoryCheckpoint<T>(
  ...args: Parameters<
    typeof import("./worker-environments/session-repository-checkpoints.js").withSessionRepositoryCheckpoint<T>
  >
) {
  return await (
    await import("./worker-environments/session-repository-checkpoints.js")
  ).withSessionRepositoryCheckpoint<T>(...args);
}

export async function prepareWorkerWorkspaceGitPack(
  ...args: Parameters<
    typeof import("./worker-environments/workspace-git-base.js").prepareWorkerWorkspaceGitPack
  >
) {
  return await (
    await import("./worker-environments/workspace-git-base.js")
  ).prepareWorkerWorkspaceGitPack(...args);
}

export async function captureWorkspaceSnapshot(
  ...args: Parameters<
    typeof import("./worker-environments/workspace-manifest-worker.js").captureWorkspaceSnapshot
  >
) {
  return await (
    await import("./worker-environments/workspace-manifest-worker.js")
  ).captureWorkspaceSnapshot(...args);
}
