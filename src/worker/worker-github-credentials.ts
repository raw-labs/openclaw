/** Canonical current gh profile/child format for worker launch bindings.
 * Account selection, host policy and sandbox admission remain in the GitHub plugin.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { inspectPathPermissions } from "@openclaw/fs-safe/permissions";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseDocument } from "yaml";
import { readSecureFile } from "../infra/fs-safe.js";

export const GITHUB_EXEC_CREDENTIAL_UNAVAILABLE =
  "GitHub Identity credential is unavailable or insecure. Reconnect or change GitHub Identity, then retry.";

async function privateProfileStat(profileDir: string) {
  const stat = await fs.lstat(profileDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(GITHUB_EXEC_CREDENTIAL_UNAVAILABLE);
  }
  if (process.platform === "win32") {
    // Windows mode bits do not establish privacy; require verified owner-only ACL access.
    const permissions = await inspectPathPermissions(profileDir);
    if (
      !permissions.ok ||
      permissions.source !== "windows-acl" ||
      permissions.ownerTrusted !== true ||
      permissions.groupReadable ||
      permissions.worldReadable ||
      permissions.groupWritable ||
      permissions.worldWritable
    ) {
      throw new Error(GITHUB_EXEC_CREDENTIAL_UNAVAILABLE);
    }
  } else if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error(GITHUB_EXEC_CREDENTIAL_UNAVAILABLE);
  }
  return stat;
}

/** Called only inside the local launcher, never by the Gateway or its supervision pipeline. */
export async function readGitHubExecToken(profileDir: string, host?: string): Promise<string> {
  try {
    const githubHost = host?.trim().toLowerCase() || "github.com";
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(githubHost) || githubHost.includes("..")) {
      throw new Error(GITHUB_EXEC_CREDENTIAL_UNAVAILABLE);
    }
    const profile = await privateProfileStat(profileDir);
    const realProfileDir = await fs.realpath(profileDir);
    const filePath = path.join(profileDir, "hosts.yml");
    // Reject FIFOs/devices before the secure reader opens them; its timeout bounds reads.
    const hosts = await fs.lstat(filePath);
    if (!hosts.isFile() || hosts.isSymbolicLink() || hosts.nlink !== 1) {
      throw new Error(GITHUB_EXEC_CREDENTIAL_UNAVAILABLE);
    }
    const snapshot = await readSecureFile({
      filePath,
      trust: { trustedDirs: [realProfileDir] },
      io: { maxBytes: 64 * 1024, timeoutMs: 5_000 },
    });
    try {
      const currentProfile = await privateProfileStat(profileDir);
      if (
        currentProfile.dev !== profile.dev ||
        currentProfile.ino !== profile.ino ||
        path.dirname(snapshot.realPath) !== realProfileDir ||
        snapshot.stat.nlink !== 1
      ) {
        throw new Error(GITHUB_EXEC_CREDENTIAL_UNAVAILABLE);
      }
      // Keep YAML diagnostics private, reject malformed documents, and disallow alias expansion.
      const document = parseDocument(snapshot.buffer.toString("utf8"), { prettyErrors: false });
      if (document.errors.length || document.warnings.length) {
        throw new Error(GITHUB_EXEC_CREDENTIAL_UNAVAILABLE);
      }
      const parsed: unknown = document.toJS({ maxAliasCount: 0 });
      const hostEntry = isRecord(parsed) ? parsed[githubHost] : undefined;
      const token =
        isRecord(hostEntry) && typeof hostEntry.oauth_token === "string"
          ? hostEntry.oauth_token.trim()
          : "";
      if (!token || /[\r\n\0]/u.test(token)) {
        throw new Error(GITHUB_EXEC_CREDENTIAL_UNAVAILABLE);
      }
      return token;
    } finally {
      snapshot.buffer.fill(0);
    }
  } catch {
    // Never retain a filesystem/YAML cause: it may contain the credential or private paths.
    throw new Error(GITHUB_EXEC_CREDENTIAL_UNAVAILABLE);
  }
}

export function managedGitHubIdentityEnvironment(params: {
  profileDir: string;
  host?: string;
  gitAuthor?: { name?: string; email?: string };
  gitConfig?: readonly (readonly [string, string])[];
}): Readonly<Record<string, string> & { GH_CONFIG_DIR: string }> {
  const author = params.gitAuthor;
  const gitConfigEntries = [
    ...(params.gitConfig ?? []),
    ...Object.entries({
      ...(author?.name ? { "user.name": author.name } : {}),
      ...(author?.email ? { "user.email": author.email } : {}),
    }),
  ];
  const gitConfigEnv = Object.fromEntries(
    gitConfigEntries.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  );
  return {
    GH_CONFIG_DIR: params.profileDir,
    GH_HOST: params.host ?? "github.com",
    ...(gitConfigEntries.length > 0
      ? { GIT_CONFIG_COUNT: String(gitConfigEntries.length), ...gitConfigEnv }
      : {}),
    ...(author?.name ? { GIT_AUTHOR_NAME: author.name, GIT_COMMITTER_NAME: author.name } : {}),
    ...(author?.email ? { GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_EMAIL: author.email } : {}),
  };
}
