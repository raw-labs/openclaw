import type {
  ControlUiAccessory,
  ControlUiHost,
  ControlUiSessionOperationBinding,
  ControlUiSessionOperationFactory,
} from "openclaw/plugin-sdk/control-ui";
import { createGitHubPublicationOperationFactory } from "./github-publication-owner.ts";
import type { GitHubPublicationPresentationBinding } from "./github-publication-owner.ts";
type Context = Pick<Parameters<ControlUiAccessory["mount"]>[1], "props" | "signal" | "presented">;
type PublicationHost = {
  connection: Pick<ControlUiHost["connection"], "connected" | "canWrite">;
  sessions: Pick<
    ControlUiHost["sessions"],
    "methodAccess" | "attachOperation" | "selectedKey" | "matches"
  >;
};
/** Vendor decisions stay with this presentation; the host retains admitted operation custody. */
export function createPublicationPresentation(
  host: PublicationHost,
  read: () => Context,
  changed: () => void,
  factory: ControlUiSessionOperationFactory<GitHubPublicationPresentationBinding>,
) {
  let binding: ControlUiSessionOperationBinding<GitHubPublicationPresentationBinding> | null = null;
  let stop: (() => void) | undefined;
  let disposed = false;
  const facts = () => {
    const value = read().props.facts;
    return value?.readCurrent ? value.readCurrent() : value;
  };
  const detach = () => {
    stop?.();
    stop = undefined;
    binding?.detach();
    binding = null;
  };
  return {
    sync() {
      const context = read();
      const row = facts()?.session;
      if (
        disposed ||
        context.signal.aborted ||
        !host.connection.connected ||
        !row ||
        !host.sessions.methodAccess?.(row, {
          method: "sessions.github.options",
          requiredScope: "operator.read",
          sessionScope: true,
        })
      ) {
        detach();
        return;
      }
      if (!binding?.matches(row)) {
        detach();
        binding = host.sessions.attachOperation?.(row, factory) ?? null;
        stop = binding?.subscribe(changed);
      }
      const held = binding;
      const currentFacts = facts();
      held?.sync({
        canPublishShared:
          !currentFacts?.participationBlocked &&
          !row.archived &&
          host.sessions.methodAccess?.(row, {
            method: "sessions.github.publish",
            requiredScope: "operator.sessions.write",
          }),
        canPublishPersonal:
          !currentFacts?.participationBlocked && !row.archived && host.connection.canWrite,
        personalReady:
          currentFacts !== undefined &&
          !currentFacts.hasActiveRun &&
          currentFacts.workspaceReady &&
          !currentFacts.workspaceConflict,
        isPresented: () => read().presented,
        isCurrent: () =>
          !disposed &&
          !read().signal.aborted &&
          facts()?.session !== undefined &&
          held?.matches(facts()!.session!) &&
          // A hidden sibling of this conversation still projects its receipt;
          // a parked, different conversation must not render into the new route.
          (read().presented ||
            host.sessions.matches(
              { sessionKey: read().props.sessionKey, agentId: read().props.agentId },
              host.sessions.selectedKey,
            )),
      });
    },
    view: () => binding?.view(),
    dispose() {
      disposed = true;
      detach();
    },
  };
}

/** One activation formatter/factory is shared by foreground discovery and its views. */
export function createPublicationFactory(host: Pick<ControlUiHost, "presentation" | "sessions">) {
  const presentation = host.presentation!;
  return createGitHubPublicationOperationFactory(
    (error) => presentation.formatError(error),
    () =>
      presentation.translate("githubPublication.capacity", {
        newAction: presentation.translate("githubPublication.newAction"),
      }),
    host.sessions.artifactKey,
  );
}
