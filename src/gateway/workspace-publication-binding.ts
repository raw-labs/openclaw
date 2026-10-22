import type { GatewayRequestContext } from "./server-methods/types.js";
import type { WorkspacePublicationHost } from "./workspace-publication-provider.js";

// Composition binds one existing host; the public Gateway context does not grant provider installation.
const publicationHosts = new WeakMap<GatewayRequestContext, WorkspacePublicationHost>();
export function bindWorkspacePublicationHost(
  context: GatewayRequestContext,
  host: WorkspacePublicationHost,
): void {
  publicationHosts.set(context, host);
}
export function readWorkspacePublicationHost(
  context: GatewayRequestContext,
): WorkspacePublicationHost | undefined {
  const selected = context.resolveGatewayContext?.() ?? context;
  return publicationHosts.get(selected);
}
