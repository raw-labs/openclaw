/** A custody owner observed a definitive mismatch; unavailable reads are not this error. */
export class RepositoryPublicationAuthorityError extends Error {
  constructor(
    message: string,
    readonly failure: { code: "workspace_changed" | "session_changed"; nextAction: string },
  ) {
    super(message);
  }
}
export class RepositoryPublicationWorkspaceChangedError extends RepositoryPublicationAuthorityError {
  constructor(message: string) {
    super(message, {
      code: "workspace_changed",
      nextAction:
        "Inspect the reconciled workspace and any recorded GitHub effects, then request a new publication after reviewing the changes.",
    });
  }
}
export class RepositoryPublicationSessionChangedError extends RepositoryPublicationAuthorityError {
  constructor() {
    super("GitHub publication session lifecycle changed.", {
      code: "session_changed",
      nextAction:
        "Review any recorded GitHub effects, then request publication from the current session.",
    });
  }
}
