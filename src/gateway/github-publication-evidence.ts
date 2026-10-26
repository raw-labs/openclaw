import { createHash } from "node:crypto";
import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import {
  GITHUB_PUBLICATION_EVIDENCE_MAX_BYTES,
  type GitHubPublicationEvidence,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { resolveSandboxedBridgeMediaPath } from "../agents/sandbox-media-paths.js";
import type { SandboxContext } from "../agents/sandbox/types.js";
import { canReadWorkspaceArtifactSource } from "../agents/sandbox/workspace-publication.js";

const MEDIA_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
]);

/** Read only inspected workspace bytes; credentials and remote transport stay in the plugin. */
export async function readGitHubPublicationEvidence(params: {
  evidence: GitHubPublicationEvidence;
  sandbox: SandboxContext | undefined;
  sessionKey: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<{
  data: Uint8Array;
  filename: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
}> {
  const { evidence, sandbox } = params;
  params.assertCurrent();
  if (!canReadWorkspaceArtifactSource(sandbox) || sandbox.sessionKey !== params.sessionKey) {
    throw new Error(
      "upload_evidence needs this conversation's active sandbox workspace; it is not offered to sessions that run directly on the host.",
    );
  }
  if (
    !evidence.path ||
    evidence.path.startsWith("~") ||
    /[\\:]/u.test(evidence.path) ||
    containsAsciiControlCharacter(evidence.path) ||
    evidence.path.split("/").some((part) => !part || part === "." || part === "..") ||
    !/^[a-f0-9]{64}$/u.test(evidence.sha256) ||
    !Number.isSafeInteger(evidence.sizeBytes) ||
    evidence.sizeBytes < 1 ||
    evidence.sizeBytes > GITHUB_PUBLICATION_EVIDENCE_MAX_BYTES
  ) {
    throw new Error(
      "Evidence requires a workspace-relative path, inspected SHA-256 and byte count up to 10 MB.",
    );
  }
  const filename = path.posix.basename(evidence.path);
  const mimeType = MEDIA_TYPES.get(path.posix.extname(filename).toLowerCase());
  if (!mimeType) {
    throw new Error("Evidence must be a PNG, JPEG, GIF, WebP, MP4, MOV or WebM image/video.");
  }
  let media: Awaited<ReturnType<typeof sandbox.fsBridge.readFileWithSource>>;
  try {
    const selected = await resolveSandboxedBridgeMediaPath({
      sandbox: { root: sandbox.workspaceDir, bridge: sandbox.fsBridge, workspaceOnly: true },
      mediaPath: evidence.path,
    });
    params.assertCurrent();
    media = await sandbox.fsBridge.readFileWithSource({
      filePath: selected.resolved,
      cwd: sandbox.workspaceDir,
      maxBytes: evidence.sizeBytes,
      signal: params.signal,
    });
  } catch (error) {
    params.assertCurrent();
    // Filesystem diagnostics may name private host paths; only the cause retains them.
    throw new Error(
      "Evidence could not be read from this conversation's workspace; no upload was attempted.",
      { cause: error },
    );
  }
  params.assertCurrent();
  // The bridge pins this provenance to the read itself, including remote mounts and aliases.
  if (media.workspaceRelativePath === undefined) {
    throw new Error("Evidence must belong to this conversation's workspace, not another mount.");
  }
  if (
    media.data.length !== evidence.sizeBytes ||
    createHash("sha256").update(media.data).digest("hex") !== evidence.sha256
  ) {
    throw new Error("Evidence bytes changed since inspection; no upload was attempted.");
  }
  if ((await detectMime({ buffer: media.data })) !== mimeType) {
    throw new Error(
      "Evidence bytes do not match the image/video filename; no upload was attempted.",
    );
  }
  params.assertCurrent();
  return {
    data: media.data,
    filename,
    mimeType,
    sha256: evidence.sha256,
    sizeBytes: evidence.sizeBytes,
  };
}
