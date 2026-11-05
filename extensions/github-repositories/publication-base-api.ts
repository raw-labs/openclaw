import { isRecord, readNonBlankString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson } from "openclaw/plugin-sdk/text-utility-runtime";

/** Returns the authenticated target-base SHA or fails the publication boundary closed. */
export function parseGitHubPublicationBaseRef(raw: string, baseBranch: string): string {
  const parsed = safeParseJson(raw);
  const ref = isRecord(parsed) ? readNonBlankString(parsed.ref) : undefined;
  const sha = isRecord(parsed) ? readNonBlankString(parsed.sha) : undefined;
  if (
    ref !== `refs/heads/${baseBranch}` ||
    !sha ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(sha)
  ) {
    throw new Error("GitHub publication workspace base branch could not be verified.");
  }
  return sha;
}
