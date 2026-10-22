import {
  githubTextReferenceSnapshot,
  type MarkdownGitHubRepository,
  type MarkdownGitHubRepositoryAliases,
} from "../../../extensions/github-repositories/browser/text-reference-api.ts";
import type { MarkdownRenderOptions } from "../components/markdown-render-options.ts";

export type GitHubReferenceOptions = MarkdownRenderOptions & {
  githubRepo?: MarkdownGitHubRepository | null;
  githubRepositories?: readonly MarkdownGitHubRepositoryAliases[];
};

/** Pure rendering fixtures consume the same immutable snapshot as the registered provider. */
export function githubReferenceOptions(options: GitHubReferenceOptions): MarkdownRenderOptions {
  const { githubRepo, githubRepositories, ...renderOptions } = options;
  return {
    ...renderOptions,
    textReferences: [githubTextReferenceSnapshot(githubRepo, githubRepositories)],
  };
}
