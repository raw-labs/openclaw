import type {
  ControlUiSessionPullRequests,
  PreparedNativeGitHubSessionRead as PreparedRepositorySessionRead,
} from "openclaw/plugin-sdk/native-github-session-read";

type TaskPullRequest = NonNullable<ControlUiSessionPullRequests["taskPullRequests"]>[number];
type ReceiptResult = {
  taskPullRequests: TaskPullRequest[];
  taskPullRequestCount: number;
  pullRequestCount: number;
};

/** The host selects accessible task receipts; the plugin interprets GitHub URLs. */
export async function readTaskPullRequestReceipts(
  read: Pick<PreparedRepositorySessionRead, "readTaskPublications">,
  input: { branchUrls?: readonly string[] },
  signal?: AbortSignal,
): Promise<ReceiptResult> {
  const result = await read.readTaskPublications(input, signal);
  const taskPullRequests: TaskPullRequest[] = [];
  for (const receipt of result.receipts) {
    const url = URL.parse(receipt.url);
    const parts = url?.pathname.split("/");
    const number = Number(parts?.[4]);
    if (
      !url ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      parts?.length !== 5 ||
      parts[3] !== "pull" ||
      !parts[1] ||
      !parts[2] ||
      !Number.isSafeInteger(number) ||
      number < 1
    ) {
      continue;
    }
    taskPullRequests.push({
      url: url.href,
      owner: parts[1],
      repo: parts[2],
      number,
      branch: receipt.branch,
      ...(receipt.title ? { title: receipt.title } : {}),
      sourceSessionKey: receipt.session.sessionKey,
      sourceAgentId: receipt.session.agentId,
    });
  }
  return {
    taskPullRequests,
    taskPullRequestCount: result.count,
    pullRequestCount: result.count + (input.branchUrls?.length ?? 0) - result.branchMatchCount,
  };
}
