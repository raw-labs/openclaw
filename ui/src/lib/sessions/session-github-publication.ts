import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../../src/gateway/control-ui-contract.js";
import type { ControlUiSessionOperationFactory } from "../../../../src/plugin-sdk/control-ui-session-operation.js";
import { t } from "../../i18n/index.ts";
import type {
  GitHubPublicationOwner,
  GitHubPublicationPresentationBinding,
} from "./github-publication-owner.ts";
import { scopedSessionArtifactKey } from "./session-key.ts";
import type { createSessionRetainedOperations } from "./session-retained-operations.ts";
import type { GitHubPublicationBinding } from "./session-types.ts";

/** Native publication keeps its contract while sharing generic host custody with plugins. */
export function createSessionGitHubPublication(
  operations: ReturnType<typeof createSessionRetainedOperations>,
) {
  return {
    ...operations,
    attach(
      row: Parameters<typeof operations.attach>[0],
      Owner: typeof GitHubPublicationOwner,
    ): GitHubPublicationBinding | null {
      const factory: ControlUiSessionOperationFactory<GitHubPublicationPresentationBinding> = {
        id: "github-publication",
        requiredMethods: ["sessions.github.publish"],
        isOperation: (value): value is GitHubPublicationOwner => value instanceof Owner,
        capacityError: () =>
          new Error(
            t("githubPublication.capacity", { newAction: t("githubPublication.newAction") }),
          ),
        create(owner) {
          const publication = new Owner(owner);
          return Object.assign(publication, {
            observeEvent(event: string, payload: unknown, currentRow: typeof row) {
              if (
                event === "sessions.changed" &&
                asNullableRecord(payload)?.reason === "github-publication"
              ) {
                publication.invalidate();
              } else if (
                event === CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT &&
                publication.result?.status === "failed"
              ) {
                const snapshots = asNullableRecord(asNullableRecord(payload)?.sessions);
                const snapshot = asNullableRecord(
                  snapshots?.[scopedSessionArtifactKey(currentRow.key, currentRow.agentId)],
                );
                if (snapshot?.status === "ready" && Array.isArray(snapshot.pullRequests)) {
                  publication.invalidate();
                }
              }
            },
          });
        },
      };
      return operations.attach(row, factory, "openclaw-native");
    },
    observeGatewayEvent(event: { event: string; payload?: unknown }) {
      if (event.event !== "sessions.changed") {
        operations.observePayload(event.event, event.payload);
      }
      return event.event === CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT;
    },
  };
}
