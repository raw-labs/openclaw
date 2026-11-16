import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../../src/gateway/control-ui-contract.js";
import type {
  ControlUiSessionOperationBinding,
  ControlUiSessionOperationFactory,
} from "../../../../src/plugin-sdk/control-ui-session-operation.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createSessionGitHubPublication } from "./session-github-publication.ts";
import type { createSessionRetainedOperations } from "./session-retained-operations.ts";

type Native = ReturnType<typeof createSessionGitHubPublication>;
type Retained = ReturnType<typeof createSessionRetainedOperations>;

/**
 * Native GitHub publication keeps its own owner. Plugin-contributed session operations
 * observe the same session lifecycle facts through a separate owner, loaded only once a
 * plugin activates: before any attachment it has no entries, so earlier facts need no replay.
 */
export function createSessionOperations(
  host: Parameters<typeof createSessionGitHubPublication>[0] &
    Parameters<typeof createSessionRetainedOperations>[0],
) {
  const githubPublication = createSessionGitHubPublication(host);
  let retained: Retained | undefined;
  let loading: Promise<void> | undefined;
  const retainedOperations = {
    /** Plugin activation awaits this before a plugin host can attach operations. */
    prepare(): Promise<void> {
      // A failed chunk load must not disable later plugin activations in this tab.
      loading ??= import("./session-retained-operations.ts").then(
        (module) => {
          retained ??= module.createSessionRetainedOperations(host);
        },
        (error: unknown) => {
          loading = undefined;
          throw error;
        },
      );
      return loading;
    },
    attach<TBinding extends object>(
      row: GatewaySessionRow,
      factory: ControlUiSessionOperationFactory<TBinding>,
      pluginId: string,
      lifecycle?: { signal: AbortSignal; onError: (error: unknown) => void },
    ): ControlUiSessionOperationBinding<TBinding> | null {
      if (!retained) {
        throw new Error("Plugin session operations are not ready; retry after plugin activation.");
      }
      return retained.attach(row, factory, pluginId, lifecycle);
    },
  };
  return {
    githubPublication,
    retainedOperations,
    observeRows(...args: Parameters<Native["observeRows"]>) {
      githubPublication.observeRows(...args);
      retained?.observeRows(...args);
    },
    observeEvent(payload: unknown) {
      githubPublication.observeEvent(payload);
      retained?.observeEvent(payload);
    },
    /** Returns true when the event belonged to pull request presentation alone. */
    observeGatewayEvent(event: string, payload: unknown): boolean {
      if (event !== "sessions.changed") {
        retained?.observePayload(event, payload);
      }
      if (event !== CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT) {
        return false;
      }
      githubPublication.observePullRequests(payload);
      return true;
    },
    invalidate() {
      githubPublication.invalidate();
      retained?.invalidate();
    },
    clear() {
      githubPublication.clear();
      retained?.clear();
    },
  };
}
