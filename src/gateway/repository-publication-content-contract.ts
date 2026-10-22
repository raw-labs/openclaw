/** Prepared display facts; session storage and sharing authority stay host-owned. */
export type RepositoryPublicationContentFactsV1 = {
  credit: { trailers: readonly string[]; logins: readonly string[] };
  assertCurrent(this: void): void;
  /** A late revoke removes disclosure; a later grant cannot add it to this request. */
  currentSessionUrl(this: void): string | undefined;
};
