import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../../src/gateway/control-ui-contract.js";
import { createSessionGitHubPublication } from "./session-github-publication.ts";
import { createSessionRetainedOperations } from "./session-retained-operations.ts";

type Native = ReturnType<typeof createSessionGitHubPublication>;

/**
 * Native GitHub publication keeps its own owner. Plugin-contributed session operations
 * observe the same session lifecycle facts through a separate owner.
 */
export function createSessionOperations(
  host: Parameters<typeof createSessionGitHubPublication>[0],
) {
  const githubPublication = createSessionGitHubPublication(host);
  const retainedOperations = createSessionRetainedOperations(host);
  return {
    githubPublication,
    retainedOperations,
    observeRows(...args: Parameters<Native["observeRows"]>) {
      githubPublication.observeRows(...args);
      retainedOperations.observeRows(...args);
    },
    observeEvent(payload: unknown) {
      githubPublication.observeEvent(payload);
      retainedOperations.observeEvent(payload);
    },
    /** Returns true when the event belonged to pull request presentation alone. */
    observeGatewayEvent(event: string, payload: unknown): boolean {
      if (event !== "sessions.changed") {
        retainedOperations.observePayload(event, payload);
      }
      if (event !== CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT) {
        return false;
      }
      githubPublication.observePullRequests(payload);
      return true;
    },
    invalidate() {
      githubPublication.invalidate();
      retainedOperations.invalidate();
    },
    clear() {
      githubPublication.clear();
      retainedOperations.clear();
    },
  };
}
