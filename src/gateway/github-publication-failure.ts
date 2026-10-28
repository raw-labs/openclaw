import { GatewayErrorDetailCodes } from "@openclaw/gateway-protocol/gateway-error-details";
import type { GitHubPublicationSelectionRejectedErrorDetails } from "@openclaw/gateway-protocol/gateway-error-details";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/index.js";
import {
  NativeGitHubPublicationCreditChangedError as RepositoryPublicationCreditChangedError,
  NativeGitHubPublicationFailureError as RepositoryPublicationFailureError,
  NativeGitHubPublicationAuthorityError as RepositoryPublicationAuthorityError,
} from "../plugin-sdk/native-github-publication-host.js";

type PublicationFailure = Pick<
  Extract<SessionGitHubPublicationResult, { status: "failed" }>,
  "code" | "nextAction"
>;

export type GitHubPublicationPreparation = {
  idempotencyKey: string;
  hasRequest: () => boolean;
};
const identityNextAction =
  "Reconnect My GitHub or System GitHub in Settings → Profile → GitHub connections (agent overrides: Agents → Tools), then request publication again.";

/** An owner observed a definitive outcome; an unavailable probe is not this failure. */
export class GitHubPublicationKnownFailure extends RepositoryPublicationFailureError {}

export function rejectGitHubPublicationSelection(
  message: string,
  preparation?: GitHubPublicationPreparation,
): never {
  let rejection: GitHubPublicationSelectionRejectedErrorDetails | undefined;
  try {
    // Check at rejection, not before awaited preparation. Another invocation may have admitted.
    if (preparation && !preparation.hasRequest()) {
      rejection = {
        code: GatewayErrorDetailCodes.GITHUB_PUBLICATION_SELECTION_REJECTED,
        idempotencyKey: preparation.idempotencyKey,
      };
    }
  } catch {
    // An unreadable receipt cannot establish that publication was not admitted.
  }
  throw new GitHubPublicationKnownFailure(
    message,
    { code: "identity_changed", nextAction: identityNextAction },
    rejection,
  );
}

export class GitHubPublicationBranchChangedError extends GitHubPublicationKnownFailure {
  constructor(options: { originalPullRequest?: boolean } = {}) {
    super("GitHub publication cannot safely extend the published branch.", {
      code: "push_rejected",
      nextAction: options.originalPullRequest
        ? "Preserve your local work and inspect the original PR's current head. Continue only after its updated source has been explicitly accepted and your intended edits reapplied without rewriting published history. Do not create a replacement PR or redirect publication to another branch."
        : "Preserve your local work and inspect the published head. To refresh the existing PR, apply the intended changes on top of that head without rewriting its history; otherwise publish from a new session branch and open a replacement PR. Repository-only checkpoints cannot adopt external branch changes; use a new session branch for those. Do not merge old history merely to make a rebased branch pushable. The broker never rewrites published history.",
    });
  }
}

export class GitHubPublicationCreditChangedError extends GitHubPublicationKnownFailure {
  constructor() {
    super("GitHub publication contributor credit changed.", {
      code: "identity_changed",
      nextAction:
        "Review contributor credit and any recorded GitHub effects, reconcile unpushed prepared commits, then request a new publication. Already published commits and pull requests are retained.",
    });
  }
}

/** An unavailable authenticated read does not establish a definitive write outcome. */
export class GitHubPublicationObservationUnavailableError extends Error {
  constructor() {
    super("GitHub publication remote branch could not be verified.");
  }
}

export function resolveGitHubPublicationFailure(error: unknown): PublicationFailure {
  if (error instanceof RepositoryPublicationCreditChangedError) {
    return new GitHubPublicationCreditChangedError().failure;
  }
  if (
    error instanceof RepositoryPublicationFailureError ||
    error instanceof RepositoryPublicationAuthorityError
  ) {
    return error.failure;
  }
  const message = error instanceof Error ? error.message : "";
  if (message.toLowerCase().includes("publication workspace base")) {
    return {
      code: "unavailable",
      nextAction:
        "The pull request base or its Git history could not be verified. Check repository read access, connectivity, and local Git objects before retrying publication.",
    };
  }
  if (message.toLowerCase().includes("publication remote branch could not be verified")) {
    return {
      code: "unavailable",
      nextAction:
        "Restore repository read access or connectivity, then verify the published branch before retrying. An unavailable observation does not prove the branch is absent or safe to overwrite.",
    };
  }
  if (message.includes("identity")) {
    return {
      code: message.includes("changed") ? "identity_changed" : "identity_unavailable",
      nextAction: identityNextAction,
    };
  }
  if (message.includes("session") || message.includes("worktree owner")) {
    return {
      code: "session_changed",
      nextAction: "Open the current session worktree and request publication again.",
    };
  }
  if (message.includes("transport configuration") || message.includes("replacement metadata")) {
    return {
      code: "workspace_changed",
      nextAction:
        "Remove the unsupported Git transport or replacement configuration from the session worktree, then retry.",
    };
  }
  if (message.includes("workspace") || message.includes("branch changed")) {
    return {
      code: "workspace_changed",
      nextAction:
        "Inspect the reconciled workspace and any recorded GitHub effects, then request a new publication after reviewing the changes.",
    };
  }
  if (message.includes("not a git")) {
    return { code: "not_git", nextAction: "Use a session-owned Git worktree to publish." };
  }
  if (message.includes("GitHub remote")) {
    return { code: "not_github", nextAction: "Use a GitHub repository remote to publish." };
  }
  if (message.includes("push")) {
    return {
      code: "push_rejected",
      nextAction:
        "Check repository write access and branch drift, then retry without force-pushing.",
    };
  }
  if (message.includes("pull request") || message.includes("GitHub")) {
    return {
      code: "github_rejected",
      nextAction: "Check pull-request permission for the effective account, then retry.",
    };
  }
  return { code: "unavailable", nextAction: "Retry after the Gateway and GitHub are available." };
}

export function isDefinitiveGitHubPublicationFailure(error: unknown): boolean {
  return (
    error instanceof RepositoryPublicationFailureError ||
    error instanceof RepositoryPublicationCreditChangedError ||
    error instanceof RepositoryPublicationAuthorityError
  );
}

export {
  RepositoryPublicationRequesterUnavailableError as GitHubPublicationRequesterUnavailableError,
  RepositoryPublicationChangePermissionError as GitHubPublicationWorkflowPermissionError,
} from "./repository-publication-errors.js";
export {
  RepositoryPublicationWorkspaceChangedError as GitHubPublicationWorkspaceChangedError,
  RepositoryPublicationSessionChangedError as GitHubPublicationSessionChangedError,
} from "./github-publication-errors.js";
