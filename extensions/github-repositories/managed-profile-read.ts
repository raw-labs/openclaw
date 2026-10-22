import fs from "node:fs/promises";
import path from "node:path";
import { readSecretFile } from "@openclaw/fs-safe/secret";
import { hasErrnoCode } from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseDocument } from "yaml";
import { GITHUB_PUBLIC_HOST as GITHUB_HOST } from "./host-api.js";
import {
  GITHUB_IDENTITY_OUTPUT_LIMIT_BYTES as PROFILE_OUTPUT_LIMIT_BYTES,
  normalizeGitHubToken as normalizeManagedGitHubToken,
} from "./read-identity-api.js";

export async function readManagedGitHubToken(profileDir: string): Promise<string | undefined> {
  if (!(await isPrivateManagedGitHubProfile(profileDir))) {
    return undefined;
  }
  try {
    let hosts: Record<string, unknown> | undefined;
    for (const name of ["hosts.yml", "config.yml"]) {
      const filePath = path.join(profileDir, name);
      const stat = await fs.lstat(filePath).catch((error: unknown) => {
        if (name === "config.yml" && hasErrnoCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      if (!stat) {
        continue;
      }
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
        return undefined;
      }
      const raw = await readSecretFile(filePath, "Managed GitHub profile", {
        maxBytes: PROFILE_OUTPUT_LIMIT_BYTES,
        rejectSymlink: true,
      });
      // parse() logs YAML warnings containing file contents. Inspect the document
      // instead so corrupt credentials never escape into parser diagnostics.
      const document = parseDocument(raw, { prettyErrors: false });
      if (document.errors.length || document.warnings.length) {
        return undefined;
      }
      const value: unknown = document.toJS({ maxAliasCount: 0 });
      if (!isRecord(value)) {
        return undefined;
      }
      if (name === "hosts.yml") {
        hosts = value;
      }
    }
    const host = hosts?.[GITHUB_HOST];
    // gh reads the active host token before considering the global keyring.
    // User-keyed entries alone cannot prove isolation from native auth.
    return isRecord(host) && typeof host.oauth_token === "string"
      ? normalizeManagedGitHubToken(host.oauth_token)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function isPrivateManagedGitHubProfile(profileDir: string): Promise<boolean> {
  try {
    const [profile, hosts] = await Promise.all([
      fs.lstat(profileDir),
      fs.lstat(path.join(profileDir, "hosts.yml")),
    ]);
    if (
      !profile.isDirectory() ||
      profile.isSymbolicLink() ||
      !hosts.isFile() ||
      hosts.isSymbolicLink()
    ) {
      return false;
    }
    return (
      process.platform === "win32" || ((profile.mode & 0o077) === 0 && (hosts.mode & 0o077) === 0)
    );
  } catch {
    return false;
  }
}
