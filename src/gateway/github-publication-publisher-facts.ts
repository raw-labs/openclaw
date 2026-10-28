import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import type { NativeGitHubPublisherProvenance } from "./repository-publication-contract.js";
export type NativePublisherFacts = NativeGitHubPublisherProvenance;
/** Validate facts entering the host; live account assertions separately authorize effects. */
export function assertNativePublisherProvenance(
  value: unknown,
): asserts value is NativeGitHubPublisherProvenance {
  if (
    !isRecord(value) ||
    (value.source !== "system-detected" &&
      value.source !== "system-configured" &&
      value.source !== "agent-override" &&
      value.source !== "personal") ||
    (value.profileId !== undefined && typeof value.profileId !== "string") ||
    !isRecord(value.account) ||
    typeof value.account.accountId !== "number" ||
    !Number.isSafeInteger(value.account.accountId) ||
    value.account.accountId < 1 ||
    typeof value.account.login !== "string" ||
    !value.account.login
  ) {
    throw new Error("Native publication publisher provenance is invalid.");
  }
}

export function publisherProvenance(
  row: Pick<
    GitHubPublicationExecutionRow,
    "identity_source" | "identity_profile_id" | "identity_account_id" | "identity_login"
  >,
): NativeGitHubPublisherProvenance {
  const provenance = {
    source: row.identity_source,
    ...(row.identity_profile_id ? { profileId: row.identity_profile_id } : {}),
    account: { accountId: row.identity_account_id, login: row.identity_login },
  };
  assertNativePublisherProvenance(provenance);
  return provenance;
}

/** Execution replays exact receipt facts; account selection remains provider-owned. */
export function matchesPublisherProvenance(
  row: Parameters<typeof publisherProvenance>[0],
  provenance: NativeGitHubPublisherProvenance,
): boolean {
  return (
    row.identity_source === provenance.source &&
    row.identity_profile_id === (provenance.profileId ?? null) &&
    row.identity_account_id === provenance.account.accountId &&
    row.identity_login === provenance.account.login
  );
}
