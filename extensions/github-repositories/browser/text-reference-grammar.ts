import { parseGitHubLinkParams } from "@openclaw/github/targets-api.js";
import type {
  ControlUiTextReferenceInput,
  ControlUiTextReference,
  ControlUiTextReferenceSnapshot,
} from "openclaw/plugin-sdk/control-ui";
import {
  markdownGitHubAliases,
  type MarkdownGitHubAliases,
  type MarkdownGitHubRepository,
  type MarkdownGitHubRepositoryAliases,
} from "./text-reference-repositories.ts";

// Keep item numbers aligned with reader targets; short numbers need a keyword.
// A trailing `.` or `-` only disqualifies when it continues into a word (`#12.txt`,
// `#12-rc`), so a reference that ends a sentence still links.
// An identifier boundary avoids rescanning each suffix of long unqualified words.
const GITHUB_ITEM_REF_RE =
  /(?<![A-Za-z0-9_.-])(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9]\d{0,9})(?!\w|[.-]\w)/g;
const GITHUB_ITEM_KEYWORD_RE = /(PR|pull request|pull|issue|fixes|closes|resolves)\s+$/i;

function qualifiedRepository(prefix: string) {
  const match = /(?:^|[\s([{"'])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(prefix);
  if (!match || [match[1], match[2]].some((part) => part === "." || part === "..")) {
    return null;
  }
  return {
    repository: { owner: match[1]!, repo: match[2]! },
    length: match[1]!.length + match[2]!.length + 1,
  };
}

function knownAlias(prefix: string, aliases: MarkdownGitHubAliases, latestStart = prefix.length) {
  const normalized = prefix.toLowerCase();
  const lastStart = prefix.slice(0, latestStart).toLowerCase().length;
  return aliases
    .filter(([alias]) => {
      const start = normalized.lastIndexOf(alias);
      return (
        start >= 0 &&
        start <= lastStart &&
        /^[,:\])]*$/u.test(normalized.slice(start + alias.length)) &&
        !/[\p{L}\p{N}_./-]/u.test(normalized[start - 1] ?? "")
      );
    })
    .toSorted(([left], [right]) => right.length - left.length)[0];
}

function referenceRepository(
  prefix: string,
  aliases: MarkdownGitHubAliases,
  fallback?: MarkdownGitHubRepository | null,
): MarkdownGitHubRepository | null | undefined {
  const raw = prefix.trimEnd();
  const tail = raw.replace(/[,:\])]+$/u, "").trimEnd();
  const quotes = /(?:^|[\s([{])(?:"(.*)"|'(.*)'|“(.*)”|‘(.*)’)$/u.exec(tail);
  const quoted = quotes?.slice(1).find((value) => value !== undefined);
  const introduced = /\b(?:repo(?:sitory)?|project)\s*[:=]?\s+([^;!?]+)$/iu.exec(raw)?.[1];
  const name = quoted ?? introduced;
  const qualifier = (name ?? tail).trim();
  const explicit = qualifiedRepository(qualifier);
  if (explicit && (name === undefined || explicit.length === qualifier.length)) {
    return explicit.repository;
  }
  // Prefer complete known names before treating their punctuation as a wrapper.
  // A known suffix inside a quoted/introduced unknown name is not that identity.
  const latestStart =
    quoted !== undefined
      ? tail.length - quoted.length - 2
      : introduced !== undefined
        ? raw.length - introduced.length
        : raw.length;
  const rawMatch = knownAlias(raw, aliases, latestStart);
  if (rawMatch) {
    return rawMatch[1];
  }
  if (name !== undefined) {
    return aliases.find(([alias]) => alias === qualifier.toLowerCase())?.[1] ?? null;
  }
  // Syntactic identifiers claim a repository, unlike ordinary Original/Follow-up prose.
  const lastWord = qualifier.match(/[^\s([{]+$/u)?.[0] ?? "";
  return /[a-z][A-Z]|\w[._]\w|\/|["'’”]$/u.test(lastWord) ? null : fallback;
}

function hasMarkdownLinkBoundaries(value: string, start: number, end: number): boolean {
  const before = value[start - 1];
  const after = value[end];
  return (
    (before === undefined || /\s/.test(before) || "([{<\"'`".includes(before)) &&
    (after === undefined || /\s/.test(after) || ".,;:!?)]}>\"'".includes(after))
  );
}

function linkedItemRepositories(links: readonly string[]) {
  const repositories = new Map<string, MarkdownGitHubRepository | null>();
  for (const href of links) {
    // Reader detail routes recognize the canonical document; visible subviews lend the same identity.
    const canonical = href.replace(
      /(\/pull\/[1-9]\d{0,9})\/(?:checks|commits(?:\/[a-fA-F\d]{7,40})?)\/?(?=[?#]|$)/u,
      "$1",
    );
    const parsed = parseGitHubLinkParams({ url: canonical });
    const target = parsed?.target;
    if (!target || target.kind === "commit") {
      continue;
    }
    const key = `${target.kind}:${target.number}`;
    const repository = { owner: target.owner.toLowerCase(), repo: target.repo.toLowerCase() };
    const previous = repositories.get(key);
    repositories.set(
      key,
      previous === undefined ||
        (previous?.owner === repository.owner && previous.repo === repository.repo)
        ? repository
        : null,
    );
  }
  return repositories;
}

/** The immutable resolver preserves the established shorthand/alias grammar. */
export function githubTextReferenceResolver(
  current?: MarkdownGitHubRepository | null,
  repositories?: readonly MarkdownGitHubRepositoryAliases[],
) {
  const aliases = markdownGitHubAliases(repositories, current);
  return ({ text, links }: ControlUiTextReferenceInput): readonly ControlUiTextReference[] => {
    const references: ControlUiTextReference[] = [];
    const linkedRepositories = linkedItemRepositories(links);
    let scannedTo = 0;
    for (const match of text.matchAll(GITHUB_ITEM_REF_RE)) {
      const number = match[2]!;
      const start = match.index;
      const end = start + match[0].length;
      const preceding = text.slice(scannedTo, start);
      const direct = qualifiedRepository(match[1] ?? preceding);
      if (match[1] && !direct) {
        continue;
      }
      const keywordEnd = direct && !match[1] ? start - direct.length : start;
      const prefix = text.slice(scannedTo, keywordEnd).match(GITHUB_ITEM_KEYWORD_RE);
      scannedTo = end;
      const keyword =
        prefix && hasMarkdownLinkBoundaries(text, keywordEnd - prefix[0].length, end)
          ? prefix[1]
          : undefined;
      if (
        (!keyword && !direct && number.length < 4) ||
        !hasMarkdownLinkBoundaries(text, keywordEnd, end) ||
        /^[.-]\w/.test(text.slice(end))
      ) {
        continue;
      }
      const kind = keyword && /^(?:pr|pull)/i.test(keyword) ? "pull" : "issue";
      const linkedKey = `${kind}:${number}`;
      const fallback = linkedRepositories.has(linkedKey)
        ? linkedRepositories.get(linkedKey)
        : current;
      const repository =
        direct?.repository ??
        (keyword
          ? referenceRepository(preceding.slice(0, -prefix![0].length), aliases, fallback)
          : fallback);
      if (!repository) {
        continue;
      }
      references.push({
        start,
        end,
        url: `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/${kind === "pull" ? "pull" : "issues"}/${number}`,
        label: `#${number}`,
      });
    }
    return references;
  };
}

export function githubTextReferenceSnapshot(
  current?: MarkdownGitHubRepository | null,
  repositories?: readonly MarkdownGitHubRepositoryAliases[],
): ControlUiTextReferenceSnapshot {
  return {
    key: JSON.stringify([current ?? null, markdownGitHubAliases(repositories, current)]),
    resolve: githubTextReferenceResolver(current, repositories),
  };
}
