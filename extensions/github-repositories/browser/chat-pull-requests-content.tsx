import type { ControlUiSessionPullRequest } from "openclaw/plugin-sdk/control-ui";
/** @jsxImportSource @solidjs/web */
import { createMemo, For, Show, useContext } from "solid-js";
import { PullRequestActions } from "./chat-pull-request-actions.tsx";
import { ChatPullRequestChecks } from "./chat-pull-request-checks.tsx";
import {
  ChecksRows,
  StatusWarning,
  STATE_LABEL_KEYS,
  type ChatPullRequestsProps,
} from "./chat-pull-request-shared.tsx";
import { SessionGitDiff } from "./native-components.tsx";
import { ContentPresentation } from "./native-context.tsx";
import { Icon, createTextOverflow, HoverMarquee } from "./presentation-components.tsx";
import { presentationTranslator } from "./presentation-context.ts";
import { chatPullRequestId } from "./pull-request-ids.ts";
import { CiDetails, CiAutomation } from "./read-ci.tsx";
import {
  orderSessionPullRequests,
  sessionPullRequestStateIcons,
} from "./session-pull-request-presentation.ts";

const formatGitHubItemReference = (item: { owner: string; repo: string; number: number }) =>
  `${item.owner}/${item.repo}#${item.number}`;

const CHECK_LABEL_KEYS = {
  passing: "chat.pullRequests.checksPassing",
  failing: "chat.pullRequests.checksFailing",
  pending: "chat.pullRequests.checksPending",
} as const;

function Checks(props: {
  pullRequest: ControlUiSessionPullRequest;
  compact?: boolean;
  sessionKey?: string;
  sessionId?: string;
  presented?: boolean;
  dismissed?: boolean;
}) {
  const t = presentationTranslator();
  const checks = () => props.pullRequest.checks;
  const label = () => {
    const current = checks();
    return current ? t(CHECK_LABEL_KEYS[current.state]) : t("chat.pullRequests.ciMonitoring");
  };
  const parentPresented = useContext(ContentPresentation);
  const presented = () => parentPresented() && (props.presented ?? true);
  const content = () => (
    <div class="chat-pr__checks-menu" role="group" aria-label={t("chat.pullRequests.ciMonitoring")}>
      <div class="chat-pr__checks-menu-header">
        <span>{t("chat.pullRequests.ciMonitoring")}</span>
        <Show when={props.pullRequest.checksUrl}>
          {(url) => (
            <a
              href={url()}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t("chat.pullRequests.openChecks")}
            >
              <Icon name="externalLink" />
            </a>
          )}
        </Show>
      </div>
      <div class="chat-pr__checks-counts">
        <ChecksRows checks={checks()} />
        <Show when={!checks()}>{t("chat.pullRequests.automationNoChecks")}</Show>
      </div>
      <CiAutomation
        pullRequest={props.pullRequest}
        sessionKey={props.sessionKey ?? ""}
        sessionId={props.sessionId ?? ""}
        presented={presented()}
      />
      <Show when={checks()}>
        <CiDetails
          pullRequest={props.pullRequest}
          sessionKey={props.sessionKey ?? ""}
          presented={presented()}
        />
      </Show>
    </div>
  );
  return (
    <ChatPullRequestChecks
      label={label()}
      showLabel={props.compact}
      checksState={checks()?.state ?? "none"}
      presented={presented()}
      dismissed={props.dismissed}
    >
      {content()}
    </ChatPullRequestChecks>
  );
}

export function ChatPullRequestRows(props: ChatPullRequestsProps) {
  const visible = createMemo(() => orderSessionPullRequests(props.pullRequests));
  return (
    <For each={visible()} keyed={chatPullRequestId}>
      {(pullRequest) => <PullRequestRow pullRequest={pullRequest()} owner={props} />}
    </For>
  );
}

function PullRequestRow(props: {
  pullRequest: ControlUiSessionPullRequest;
  owner: ChatPullRequestsProps;
}) {
  const t = presentationTranslator();
  let row: HTMLElement | undefined;
  const dismissLabel = () =>
    t("chat.pullRequests.dismiss", { reference: formatGitHubItemReference(props.pullRequest) });
  const disabled = () => Boolean(props.owner.dismissDisabled);
  const dismiss = () => {
    props.owner.onDismiss(props.pullRequest);
  };
  const badge = () => {
    const checks = props.pullRequest.checks;
    if (props.owner.status !== "ready" || !checks) {
      return undefined;
    }
    return checks.failed > 0
      ? "failed"
      : checks.running > 0
        ? "running"
        : checks.passed > 0
          ? "passed"
          : undefined;
  };
  return (
    <article
      ref={(element) => (row = element)}
      class={["chat-pr", { "chat-pr--compact chat-pr--summary": props.owner.compact }]}
      data-state={props.pullRequest.state}
    >
      <a
        class="chat-pr__link"
        data-link-reader-preview={props.owner.compact ? "off" : undefined}
        href={props.pullRequest.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t("chat.pullRequests.linkLabel", {
          reference: formatGitHubItemReference(props.pullRequest),
          title: props.pullRequest.title,
        })}
      >
        <span class="chat-pr__icon" aria-hidden="true">
          <Icon name={sessionPullRequestStateIcons[props.pullRequest.state]} />
          <Show when={props.owner.compact && badge()}>
            {(state) => (
              <span class={["chat-pr__badge", `chat-pr__badge--${state()}`]}>
                <Show when={state() !== "running"} fallback={<span class="btn__spinner" />}>
                  <Icon name={state() === "failed" ? "x" : "check"} />
                </Show>
              </span>
            )}
          </Show>
        </span>
        <Show when={!props.owner.compact}>
          <span class="chat-pr__number">{formatGitHubItemReference(props.pullRequest)}</span>
        </Show>
        <span class="chat-pr__identity">
          <Show
            when={props.owner.compact}
            fallback={
              <span
                ref={createTextOverflow(() => props.pullRequest.branch)}
                class="chat-pr__branch"
              >
                {props.pullRequest.branch}
              </span>
            }
          >
            <HoverMarquee
              class="chat-pr__title"
              content={props.pullRequest.title}
              options={{
                host: () => (row?.closest(".chat-details[data-desktop]") ? row : undefined),
                stationaryWithoutHost: true,
              }}
            />
          </Show>
        </span>
      </a>
      <Show
        when={props.owner.compact}
        fallback={
          <span class="chat-pr__meta">
            <SessionGitDiff classPrefix="chat-pr" item={props.pullRequest} />
            <Checks
              pullRequest={props.pullRequest}
              sessionKey={props.owner.sessionKey}
              sessionId={props.owner.sessionId}
              presented={props.owner.presented}
              dismissed={props.owner.dismissed}
            />
            <Show when={props.pullRequest.state !== "open"}>
              <span class="chat-pr__state">{t(STATE_LABEL_KEYS[props.pullRequest.state])}</span>
            </Show>
            <Show
              when={props.pullRequest.state !== "merged" || props.owner.status === "unavailable"}
            >
              <StatusWarning status={props.owner.status} />
            </Show>
            <button
              class="chat-pr__dismiss"
              type="button"
              disabled={disabled()}
              aria-label={dismissLabel()}
              onClick={dismiss}
            >
              <Icon name="x" />
            </button>
          </span>
        }
      >
        <PullRequestActions
          label={t("chat.pullRequests.actions", {
            reference: formatGitHubItemReference(props.pullRequest),
          })}
          disabled={disabled()}
          presented={props.owner.presented ?? true}
          dismissed={props.owner.dismissed}
          onDismiss={dismiss}
          pullRequest={props.pullRequest}
          owner={props.owner}
        />
      </Show>
    </article>
  );
}
