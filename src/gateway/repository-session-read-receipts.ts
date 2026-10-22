import { createRetainedCache } from "../infra/retained-cache.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import type { TaskPublicationRead } from "../state/github-publication-task-reads.worker.js";
import { readGitHubPublicationInWorker } from "../state/github-publication-worker.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import type { RepositoryTaskPublications } from "./repository-session-read.types.js";

/** The existing receipt backend owns schema and audience filtering; no row or database handle escapes. */
const cache = createRetainedCache<Promise<RepositoryTaskPublications>>();
githubPublicationReceipts.subscribeFacts((change) => {
  if (change.kind === "committed" || change.kind === "unknown") {
    cache.clear();
  }
});
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened") {
    cache.clear();
  }
});

export function createRepositoryTaskPublicationReader(signal: AbortSignal) {
  return async (
    input: TaskPublicationRead,
    assertCurrent: () => void,
    readSignal?: AbortSignal,
  ): Promise<RepositoryTaskPublications> => {
    signal.throwIfAborted();
    readSignal?.throwIfAborted();
    assertCurrent();
    const source = captureOpenClawStateReadContext();
    source.admission.assertCurrent();
    const key = JSON.stringify([source.admission.identity.key, input]);
    let pending = cache.get(key, readSignal);
    if (!pending) {
      pending = (async () => {
        const reply = await readGitHubPublicationInWorker({
          type: "githubPublications.taskReceipts",
          input,
        });
        source.admission.assertCurrent();
        const result =
          reply?.type === "githubPublications.taskReceipts"
            ? reply.result
            : { receipts: [], count: 0, branchMatchCount: 0 };
        return {
          receipts: result.receipts.flatMap((row) =>
            row.pull_request_url
              ? [
                  {
                    url: row.pull_request_url,
                    branch: row.branch,
                    ...(row.title ? { title: row.title } : {}),
                    session: {
                      sessionKey: row.session_key,
                      agentId: row.agent_id,
                    },
                  },
                ]
              : [],
          ),
          count: result.count,
          branchMatchCount: result.branchMatchCount,
        };
      })();
      cache.set(key, pending, readSignal);
      const selected = pending;
      void pending.catch(() => cache.delete(key, selected));
    }
    const result = await pending;
    source.admission.assertCurrent();
    signal.throwIfAborted();
    readSignal?.throwIfAborted();
    assertCurrent();
    return result;
  };
}
