import type {
  PreparedRepositorySessionRead,
  RepositorySessionSourceScope,
  RepositoryTaskPublications,
} from "./repository-session-read.types.js";

/** Guards stay in private closures; public observations cannot acquire their authority. */
export function guardRepositorySessionRead(
  target: PreparedRepositorySessionRead,
  options: {
    assertCurrent: () => void;
    identity?: string;
    taskAudienceKey?: string;
    readTaskPublications?: (
      input: { branchUrls?: readonly string[] },
      signal?: AbortSignal,
    ) => Promise<RepositoryTaskPublications>;
  },
): PreparedRepositorySessionRead {
  const assertCurrent = () => {
    target.assertCurrent();
    options.assertCurrent();
  };
  const readTask = options.readTaskPublications ?? target.readTaskPublications;
  return Object.freeze({
    ...target,
    identity: options.identity ?? target.identity,
    taskAudienceKey: options.taskAudienceKey ?? target.taskAudienceKey,
    includesTaskPublications:
      Boolean(options.readTaskPublications) || target.includesTaskPublications,
    assertCurrent,
    async withSource<T>(
      operation: (scope: RepositorySessionSourceScope) => Promise<T>,
    ): Promise<T> {
      assertCurrent();
      return await target.withSource(async (source) => {
        const assertSource = () => {
          assertCurrent();
          source.assertCurrent();
        };
        assertSource();
        const result = await operation({
          identity: source.identity,
          assertCurrent: assertSource,
          async readCheckoutFacts(refresh) {
            assertSource();
            const facts = await source.readCheckoutFacts(refresh);
            assertSource();
            return facts;
          },
          async readCheckoutRevision(input) {
            assertSource();
            const facts = await source.readCheckoutRevision(input);
            assertSource();
            return facts;
          },
          async readCheckoutBranchFacts(input, refresh) {
            assertSource();
            const facts = await source.readCheckoutBranchFacts(input, refresh);
            assertSource();
            return facts;
          },
        });
        assertSource();
        return result;
      });
    },
    async readTaskPublications(input: { branchUrls?: readonly string[] }, signal?: AbortSignal) {
      signal?.throwIfAborted();
      assertCurrent();
      const result = await readTask(input, signal);
      signal?.throwIfAborted();
      assertCurrent();
      return result;
    },
  });
}
