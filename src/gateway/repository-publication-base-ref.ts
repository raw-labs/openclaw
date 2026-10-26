/** Normalize an accepted workspace base ref to its branch name; hashes retain the caller's default. */
export function publicationBaseBranch(baseRef: string, defaultBranch: string): string {
  const trimmed = baseRef.trim();
  if (!trimmed || trimmed === "HEAD" || /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(trimmed)) {
    return defaultBranch;
  }
  for (const prefix of ["refs/remotes/origin/", "origin/", "refs/heads/"]) {
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}
