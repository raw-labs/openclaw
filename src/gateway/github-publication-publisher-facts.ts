import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import type { RepositoryPublisherReference } from "./repository-publication-contract.js";
export type NativePublisherFacts = {
  source: "system-detected" | "system-configured" | "agent-override" | "personal";
  profileId?: string;
  account: { accountId: number; login: string };
};
/** Maps verified provenance into the fixed native receipt format. It grants no authority. */
export function encodeNativePublisher(facts: NativePublisherFacts): RepositoryPublisherReference {
  const reference = JSON.stringify([
    "native-github-v1",
    facts.source,
    facts.profileId ?? null,
    facts.account.accountId,
    facts.account.login,
  ]);
  return reference;
}
/** Private storage adapter; the engine does not reinterpret this as a live account selection. */
export function decodeNativePublisher(
  reference: RepositoryPublisherReference,
): NativePublisherFacts {
  const value: unknown = JSON.parse(reference);
  if (!Array.isArray(value) || value.length !== 5) {
    throw new Error("Native publication publisher provenance is invalid.");
  }
  const [format, source, profileId, accountId, login]: unknown[] = value;
  if (
    format !== "native-github-v1" ||
    (source !== "system-detected" &&
      source !== "system-configured" &&
      source !== "agent-override" &&
      source !== "personal") ||
    (profileId !== null && typeof profileId !== "string") ||
    typeof accountId !== "number" ||
    !Number.isSafeInteger(accountId) ||
    accountId < 1 ||
    typeof login !== "string" ||
    !login ||
    JSON.stringify(value) !== reference
  ) {
    throw new Error("Native publication publisher provenance is invalid.");
  }
  return { source, ...(profileId !== null ? { profileId } : {}), account: { accountId, login } };
}

/** Account login casing is presentation; changing account, profile or source is a new selection. */
export function sameNativePublisherSelection(
  actual: NativePublisherFacts,
  expected: NativePublisherFacts,
): boolean {
  return (
    actual.source === expected.source &&
    actual.profileId === expected.profileId &&
    actual.account.accountId === expected.account.accountId &&
    actual.account.login.toLowerCase() === expected.account.login.toLowerCase()
  );
}

export function publisherReference(
  row: Pick<
    GitHubPublicationExecutionRow,
    "identity_source" | "identity_profile_id" | "identity_account_id" | "identity_login"
  >,
) {
  const source = row.identity_source;
  if (
    source !== "personal" &&
    source !== "system-configured" &&
    source !== "system-detected" &&
    source !== "agent-override"
  ) {
    throw new Error("Native publication publisher provenance is invalid.");
  }
  return encodeNativePublisher({
    source,
    ...(row.identity_profile_id ? { profileId: row.identity_profile_id } : {}),
    account: { accountId: row.identity_account_id, login: row.identity_login },
  });
}
