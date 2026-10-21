import type {
  UserGitHubConnection,
  UserGitHubConnected,
} from "openclaw/plugin-sdk/repository-oauth-host";
import { resolveManagedGitHubProfileDir } from "./tool-identity-api.js";
export const profileDir = (profileId: string) =>
  resolveManagedGitHubProfileDir({
    agentId: "",
    scope: "personal",
    profileId,
  });
export function requirePending(
  record: UserGitHubConnection | undefined,
  generation: string,
  requestId: string,
): UserGitHubConnection & {
  pending: NonNullable<UserGitHubConnection["pending"]>;
} {
  if (
    !record?.pending ||
    record.generation !== generation ||
    record.pending.requestId !== requestId ||
    record.pending.expiresAtMs <= Date.now()
  ) {
    throw new Error("My GitHub authorization changed or expired; start again.");
  }
  return {
    ...record,
    pending: record.pending,
  };
}
export function needsRefresh(selection: UserGitHubConnected): boolean {
  return (
    Boolean(selection.refresh?.tokens) ||
    (selection.refreshFailure !== "expired" &&
      selection.refreshExpiresAtMs > Date.now() &&
      (Boolean(selection.refresh) || selection.accessExpiresAtMs <= Date.now() + 600000))
  );
}
