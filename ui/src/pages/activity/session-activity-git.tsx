import { createMemo, onSettled, Show } from "solid-js";
import { mountActivityRead } from "../../../../extensions/github-repositories/browser/read-presentation-api.ts";
import { orderSessionPullRequests } from "../../../../extensions/github-repositories/read-facts-api.ts";
import type { ControlUiSessionPullRequest } from "../../../../src/gateway/control-ui-contract.js";
import type { ControlUiLinkReaderPreview } from "../../../../src/shared/control-ui-link-reader.js";
import type { ApplicationContext } from "../../app/context.ts";
import { availableLinkPreviewReaders } from "../../app/link-reader-routing.ts";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import "../../components/link-reader-hovercard-registration.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { sessionPullRequestsForGateway } from "../../lib/session-pull-requests.ts";
import { repositoryReadView } from "../../plugins/repository-read-view.tsx";

registerEnglishCatalog(registerActivityEnglish);

function pullRequestPreview(pr: ControlUiSessionPullRequest): ControlUiLinkReaderPreview {
  return {
    url: pr.url,
    title: pr.title,
    subtitle: pr.owner + "/" + pr.repo + " #" + pr.number,
    badge: {
      label: t("activity.git." + pr.state),
      tone:
        pr.state === "merged"
          ? "accent"
          : pr.state === "open"
            ? "positive"
            : pr.state === "closed"
              ? "negative"
              : "neutral",
    },
    author: pr.author?.login,
    authorUrl: pr.author?.login
      ? "https://github.com/" + encodeURIComponent(pr.author.login)
      : undefined,
    metadata: [
      ...(pr.additions === undefined
        ? []
        : [{ label: "", value: "+" + pr.additions, tone: "positive" as const }]),
      ...(pr.deletions === undefined
        ? []
        : [{ label: "", value: "−" + pr.deletions, tone: "negative" as const }]),
    ],
  };
}

type ActivitySessionGitProps = {
  context: ApplicationContext;
  sessionKey?: string;
  agentId?: string;
};

export function ActivitySessionGit(props: ActivitySessionGitProps) {
  const scope = createMemo(
    () => ({ gateway: props.context.gateway, key: props.sessionKey ?? "" }),
    { equals: (a, b) => a.gateway === b.gateway && a.key === b.key },
  );
  return (
    <Show when={scope()} keyed>
      {(source) => SessionGit(source, props)}
    </Show>
  );
}

function SessionGit(
  source: { gateway: ApplicationContext["gateway"]; key: string },
  props: ActivitySessionGitProps,
) {
  const token = {};
  const store = sessionPullRequestsForGateway(source.gateway);
  const gatewayProjection = projectGateway(source.gateway);
  const projection = projectOwner(store, (owner) => owner.get(source.key));
  // Each keyed Gateway/session scope owns exactly one remote watch.
  onSettled(() => {
    store.watch(token, [source.key], { foreground: true });
    return () => store.unwatch(token);
  });
  const connection = () => gatewayProjection.read().snapshot;
  const snapshot = () => projection.read();
  const branch = createMemo(() => {
    const current = snapshot();
    return current?.pullRequests.some((pr) => pr.state === "open" || pr.state === "draft")
      ? undefined
      : current?.branch;
  });
  const pullRequests = createMemo(() => orderSessionPullRequests(snapshot()?.pullRequests ?? []));
  const visible = () => Boolean(branch() || pullRequests().length);
  const stale = () => snapshot()?.status !== "ready" || connection().phase !== "connected";
  return (
    <openclaw-activity-session-git>
      <Show when={visible()}>
        <openclaw-link-reader-hovercard-provider
          prop:client={connection().client}
          prop:readers={availableLinkPreviewReaders(connection())}
          prop:agentId={props.agentId ?? ""}
          prop:sessionKey={props.sessionKey}
          prop:previewSeeds={pullRequests().map(pullRequestPreview)}
        >
          {repositoryReadView(mountActivityRead, () => ({
            branch: branch(),
            pullRequests: pullRequests(),
            stale: stale(),
          }))}
        </openclaw-link-reader-hovercard-provider>
      </Show>
    </openclaw-activity-session-git>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-activity-session-git": HTMLAttributes<HTMLElement>;
    }
  }
}
