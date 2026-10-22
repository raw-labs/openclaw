import type { ProjectsListResult } from "@openclaw/gateway-protocol";
import { parseProjectGitUrl } from "../project-url-api.ts";
export type MarkdownGitHubRepository = { owner: string; repo: string };
export type MarkdownGitHubRepositoryAliases = {
  aliases: readonly string[];
} & (MarkdownGitHubRepository | { owner?: never; repo?: never });
export type MarkdownGitHubAliases = readonly (readonly [string, MarkdownGitHubRepository | null])[];

/** Unknown origins participate in collisions: a hidden project must not pick a public namesake. */
export function markdownGitHubAliases(
  repositories: readonly MarkdownGitHubRepositoryAliases[] = [],
  current?: MarkdownGitHubRepository | null,
): MarkdownGitHubAliases {
  const aliases = new Map<string, MarkdownGitHubRepository | null>();
  for (const entry of [...repositories, ...(current ? [{ ...current, aliases: [] }] : [])]) {
    const repository =
      entry.owner && entry.repo
        ? { owner: entry.owner.toLowerCase(), repo: entry.repo.toLowerCase() }
        : null;
    for (const name of [...entry.aliases, ...(repository ? [repository.repo] : [])]) {
      const alias = name.trim().toLowerCase();
      if (!alias) {
        continue;
      }
      const previous = aliases.get(alias);
      aliases.set(
        alias,
        previous === undefined ||
          (previous?.owner === repository?.owner && previous?.repo === repository?.repo)
          ? repository
          : null,
      );
    }
  }
  return [...aliases].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Non-GitHub remote names are negative aliases only; they never supply link coordinates. */
function unresolvedOriginBasename(origin: string | undefined): string | undefined {
  if (!origin) {
    return undefined;
  }
  // Mirror the sanitizer's host:path forms, including bracketed IPv6 and
  // home-relative one-component paths. Local paths never supply aliases.
  const scp = /^(?![A-Za-z]:[/\\])(?:\[[^\]]+\]|[^:@/\s]+):((?!\/\/)[^\s\\]+)$/u.exec(origin);
  let pathname = scp?.[1];
  try {
    if (!pathname) {
      const url = new URL(origin);
      if (!url.hostname || url.username || url.password) {
        return undefined;
      }
      pathname = url.pathname;
    }
    const segment = pathname.split("/").findLast(Boolean);
    const name = segment
      ? decodeURIComponent(segment)
          .replace(/\.git$/iu, "")
          .trim()
      : "";
    return name && !/[/\\\p{Cc}]/u.test(name) && name !== "." && name !== ".." ? name : undefined;
  } catch {
    return undefined;
  }
}

export function projectGitHubRepositories(
  projects: ProjectsListResult["projects"],
): MarkdownGitHubRepositoryAliases[] {
  return projects.map(({ displayName, originUrl }) => {
    // projects.list removes Git usernames. Restore only known default GitHub shapes,
    // never arbitrary credentials/hosts, paths, project IDs, or guessed owners.
    const origin = originUrl
      ?.replace(/^github\.com:/iu, "git@github.com:")
      .replace(/^ssh:\/\/github\.com(?::22)?\//iu, "ssh://git@github.com/");
    const parsed = origin ? parseProjectGitUrl(origin, "github.com") : null;
    const [owner, repo] = parsed ? new URL(parsed.url).pathname.slice(1, -4).split("/") : [];
    if (owner && repo) {
      return { owner, repo, aliases: [displayName] };
    }
    const basename = unresolvedOriginBasename(originUrl);
    return {
      aliases:
        basename && basename.toLowerCase() !== displayName.toLowerCase()
          ? [displayName, basename]
          : [displayName],
    };
  });
}
