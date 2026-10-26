import { readNativeGitHubToken } from "../agents/github-read-identity.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import {
  encodeNativePublisher,
  decodeNativePublisher,
  sameNativePublisherSelection,
  performRepositoryPublicationGit,
  type RepositoryPublicationPublisher,
} from "../plugin-sdk/repository-publication-engine.js";

const publishers = new WeakMap<
  RepositoryPublicationPublisher,
  () => PreparedGitHubPublicationIdentity
>();
/** The plugin retains credentials and the live selected account; the host receives provenance only. */
export async function prepareGitHubPublisher(
  _agentId: string,
  expected: string | undefined,
  owner: {
    prepare(): Promise<PreparedGitHubPublicationIdentity>;
    isCurrent(identity: PreparedGitHubPublicationIdentity): boolean;
  },
): Promise<RepositoryPublicationPublisher> {
  let identity = await owner.prepare();
  const selected = expected ? decodeNativePublisher(expected) : identity;
  const reference = expected ?? encodeNativePublisher(identity);
  if (!sameNativePublisherSelection(identity, selected)) {
    throw new Error("GitHub publication identity changed.");
  }
  const assertCurrent = () => {
    if (!owner.isCurrent(identity)) {
      throw new Error("GitHub publication identity changed.");
    }
  };
  const publisher: RepositoryPublicationPublisher = {
    reference,
    author: {
      name: identity.account.login,
      email: `${identity.account.accountId}+${identity.account.login}@users.noreply.github.com`,
    },
    assertCurrent,
    async refresh() {
      assertCurrent();
      const next = await owner.prepare();
      assertCurrent();
      if (!sameNativePublisherSelection(next, selected)) {
        throw new Error("GitHub publication identity changed.");
      }
      identity = next;
      assertCurrent();
    },
    async authorizeGit(transfer) {
      assertCurrent();
      const token = await readNativeGitHubToken(identity.env, true, identity.host);
      assertCurrent();
      if (!token) {
        throw new Error("GitHub publication credential is unavailable.");
      }
      await performRepositoryPublicationGit(transfer, {
        httpAuthorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        assertCurrent,
      });
    },
  };
  assertCurrent();
  publishers.set(publisher, () => {
    assertCurrent();
    return identity;
  });
  return publisher;
}
/** Only this plugin's publisher leases can reach its GitHub transport. */
export function readGitHubPublisher(
  publisher: RepositoryPublicationPublisher,
): PreparedGitHubPublicationIdentity {
  const read = publishers.get(publisher);
  if (!read) {
    throw new Error("GitHub publication publisher is unavailable.");
  }
  return read();
}
