import {
  readSessionMessageDisplayContent,
  readSessionProjectionFinalMessageIdentity,
} from "openclaw/plugin-sdk/control-ui";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseGitHubTarget } from "../reader/src/targets.ts";

const URL_CANDIDATE = /https:\/\/github\.com\/[^\s<>()\]}'"`]+/giu;
const RECEIPT_LIMIT = 200;
const RECEIPT_MAX_CHARS = 4096;
const STREAM_LINK_TAIL_CHARS = 256;

type RefreshOwner = {
  receipts: Set<string>;
  tail?: { runId: string; text: string; linked: boolean };
};
function hasPullRequestLink(text: string): boolean {
  for (const match of text.matchAll(URL_CANDIDATE)) {
    const url = URL.parse(match[0].replace(/[.,;:!?]+$/u, ""));
    const parts = url?.pathname.split("/");
    if (
      !url ||
      !parts ||
      parts[3] !== "pull" ||
      !/^[1-9]\d{0,9}$/u.test(parts[4] ?? "") ||
      !/^(?:\/(?:files|checks|commits(?:\/[a-fA-F\d]{7,40})?))?\/?$/u.test(
        "/" + parts.slice(5).join("/"),
      )
    ) {
      continue;
    }
    try {
      if (
        parseGitHubTarget({
          kind: "pull",
          owner: decodeURIComponent(parts[1] ?? ""),
          repo: decodeURIComponent(parts[2] ?? ""),
          number: Number(parts[4]),
        })
      ) {
        return true;
      }
    } catch {
      /* Invalid escaped links do not identify a repository. */
    }
  }
  return false;
}

/** Watched session keys and the activation lifetime own freshness emission receipts. */
export function createChatPullRequestInvalidation(refresh: (key: string) => boolean) {
  const owners = new Map<string, RefreshOwner>();
  const ownerFor = (key: string) => {
    let owner = owners.get(key);
    if (!owner) {
      owner = { receipts: new Set() };
      owners.set(key, owner);
    }
    return owner;
  };
  const request = (key: string, owner: RefreshOwner, receipt: string | null) => {
    const remember = receipt !== null && receipt.length <= RECEIPT_MAX_CHARS;
    if (remember && owner.receipts.has(receipt)) {
      return;
    }
    if (!refresh(key)) {
      return;
    }
    if (remember) {
      owner.receipts.add(receipt);
      if (owner.receipts.size > RECEIPT_LIMIT) {
        const oldest = owner.receipts.values().next().value;
        if (oldest !== undefined) {
          owner.receipts.delete(oldest);
        }
      }
    }
  };
  return {
    stream(key: string, runId: string | undefined, delta: string) {
      const owner = ownerFor(key);
      const run = runId ?? "";
      const previous = owner.tail?.runId === run ? owner.tail : undefined;
      const text = (previous?.text ?? "") + delta;
      const linked = previous?.linked === true || hasPullRequestLink(text);
      owner.tail = { runId: run, text: text.slice(-STREAM_LINK_TAIL_CHARS), linked };
      if (linked) {
        request(key, owner, JSON.stringify(["stream", run]));
      }
    },
    final(key: string, runId: string | undefined, message: unknown) {
      const owner = ownerFor(key);
      const candidate = asNullableRecord(message);
      if (
        typeof candidate?.role === "string" &&
        candidate.role.trim().toLowerCase() !== "assistant"
      ) {
        return;
      }
      const normalized =
        candidate && !Object.hasOwn(candidate, "content") && typeof candidate.text === "string"
          ? { ...candidate, role: "assistant", content: [{ type: "text", text: candidate.text }] }
          : candidate;
      const linked = owner.tail?.runId === (runId ?? "") && owner.tail.linked;
      if (!linked && !hasPullRequestLink(readSessionMessageDisplayContent(normalized).text)) {
        return;
      }
      const identity = readSessionProjectionFinalMessageIdentity(normalized);
      request(key, owner, runId && identity ? JSON.stringify(["final", runId, identity]) : null);
    },
    reset(key?: string) {
      if (key === undefined) {
        owners.clear();
      } else {
        owners.delete(key);
      }
    },
    retain(keys: ReadonlySet<string>) {
      for (const key of owners.keys()) {
        if (!keys.has(key)) {
          owners.delete(key);
        }
      }
    },
  };
}
