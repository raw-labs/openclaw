import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  GitHubPublicationRequesterPolicy,
  GitHubPublicationRequesterPolicyV2,
} from "./github-publication-requester.js";
const workerRequesters = resolveGlobalSingleton(
  Symbol.for("openclaw.githubPublicationWorkerRequesters"),
  () => new WeakSet<GitHubPublicationRequesterPolicy>(),
);
/** Registration proves this process prepared the live source-capable requester. */
export function registerGitHubPublicationRequesterV2(
  requester: GitHubPublicationRequesterPolicy,
): void {
  workerRequesters.add(requester);
}
/** Classify before invoking released assertions; failed worker work never selects legacy. */
export function isGitHubPublicationRequesterV2(
  requester: GitHubPublicationRequesterPolicy,
): requester is GitHubPublicationRequesterPolicyV2 {
  return workerRequesters.has(requester);
}
