import { createMemo, createUniqueId, Show, useContext } from "solid-js";
import { mountPullRequestRows } from "../../../../../extensions/github-repositories/browser/read-presentation-api.ts";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequestSnapshot,
} from "../../../../../src/gateway/control-ui-contract.js";
import { SessionGitDiff } from "../../../components/session-git-diff.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { createMenuControls, Menu, type MenuHandle } from "../../../components/solid/menu.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerGitHubEnglish } from "../../../i18n/locales/en-github.ts";
import type { PresentationValue } from "../../../lib/presentation.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import "../../../components/tooltip.ts";
import { projectPresentation } from "../../../lib/reactive/presentation.ts";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { repositoryReadCi } from "../../../plugins/repository-read-ci.tsx";
import { repositoryReadView } from "../../../plugins/repository-read-view.tsx";
import { GitHubPublicationAction, GitHubPublicationDetails } from "./chat-github-publication.tsx";
import { StatusWarning, type ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import { hasChatPullRequests, retainedPublication, showWorkRow } from "./chat-pull-requests.ts";
import "./chat-ci-details.ts";
import "./chat-ci-automation-control.ts";

registerGitHubEnglish();

function WorkRow(props: {
  branch?: ControlUiSessionBranch;
  status: ControlUiSessionPullRequestSnapshot["status"];
  onOpenSessionDiff?: () => void;
  publication?: GitHubPublicationView;
  onDismissBranch?: (branch: ControlUiSessionBranch) => void;
  presented?: PresentationValue;
  compact?: boolean;
}) {
  const published = () =>
    !props.branch && props.publication?.result?.status === "published"
      ? props.publication.result
      : undefined;
  return (
    <Show
      when={props.compact ? props.branch : undefined}
      fallback={
        <article
          class="chat-pr"
          data-state={published() ? "published" : props.branch ? "branch" : "publication"}
        >
          <span class="chat-pr__link chat-pr__link--static">
            <span class="chat-pr__icon" aria-hidden="true">
              <Icon name={published() || !props.branch ? "gitPullRequest" : "gitBranch"} />
            </span>
            <span class="chat-pr__identity">
              <span
                ref={createTextOverflow(() => published()?.repository ?? props.branch?.repo)}
                class="chat-pr__repo"
              >
                {published()?.repository ?? props.branch?.repo ?? t("chat.pullRequests.publishPr")}
              </span>
              <span
                ref={createTextOverflow(() => published()?.branch ?? props.branch?.branch)}
                class="chat-pr__branch"
              >
                {published()?.branch ?? props.branch?.branch}
              </span>
            </span>
          </span>
          <span class="chat-pr__meta">
            <Show when={!published() ? props.branch : undefined}>
              {(branch) => (
                <SessionGitDiff
                  classPrefix="chat-pr"
                  item={branch()}
                  onOpen={props.onOpenSessionDiff}
                />
              )}
            </Show>
            <StatusWarning status={props.status} />
            <Show
              when={props.publication}
              fallback={
                <Show when={props.branch?.createUrl}>
                  {(url) => (
                    <a
                      class="chat-pr__create"
                      href={url()}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t("chat.pullRequests.createPrLabel", {
                        branch: props.branch?.branch ?? "",
                      })}
                    >
                      {t("chat.pullRequests.createPr")}
                    </a>
                  )}
                </Show>
              }
            >
              {(publication) => (
                <GitHubPublicationAction publication={publication()} presented={props.presented} />
              )}
            </Show>
            <Show when={props.branch && !published() && props.onDismissBranch}>
              <button
                class="chat-pr__dismiss"
                type="button"
                disabled={props.publication?.activity != null}
                aria-label={t("chat.pullRequests.dismissBranch", {
                  branch: props.branch?.branch ?? "",
                })}
                onClick={() => {
                  if (props.branch) {
                    props.onDismissBranch?.(props.branch);
                  }
                }}
              >
                <Icon name="x" />
              </button>
            </Show>
          </span>
          <Show when={props.publication}>
            {(publication) => <GitHubPublicationDetails publication={publication()} />}
          </Show>
        </article>
      }
    >
      {(branch) => (
        <article class="chat-pr chat-pr--summary chat-pr--unpublished" data-state="branch">
          <span class="chat-pr__link chat-pr__link--static">
            <span class="chat-pr__icon" aria-hidden="true">
              <Icon name="gitBranch" />
            </span>
            <span ref={createTextOverflow(() => branch().branch)} class="chat-pr__branch">
              {branch().branch}
            </span>
          </span>
          <SessionGitDiff classPrefix="chat-pr" item={branch()} onOpen={props.onOpenSessionDiff} />
          <BranchActions
            branch={branch()}
            status={props.status}
            publication={props.publication}
            presented={props.presented}
            onDismiss={props.onDismissBranch}
          />
        </article>
      )}
    </Show>
  );
}

function BranchActions(props: {
  branch: ControlUiSessionBranch;
  status: ControlUiSessionPullRequestSnapshot["status"];
  publication?: GitHubPublicationView;
  presented?: PresentationValue;
  onDismiss?: (branch: ControlUiSessionBranch) => void;
}) {
  const id = createUniqueId();
  const controls = createMenuControls();
  const createLinkRef = controls.ref();
  const dismissRef = controls.ref();
  let menu: MenuHandle | undefined;
  const parentPresented = useContext(ContentPresentation);
  const presentation = createMemo(() => projectPresentation(props.presented ?? true));
  const presented = () => parentPresented() && presentation().read();

  return (
    <Menu
      controls={controls}
      id={"chat-pr-branch-actions-" + id}
      class="chat-pr__actions"
      label={t("chat.pullRequests.actions", { reference: props.branch.branch })}
      triggerClass="chat-pr__actions-trigger"
      trigger={<Icon name="moreHorizontal" />}
      placement="bottom-end"
      panelClass="chat-pr-menu chat-pr-branch-menu"
      open={presented() ? undefined : false}
      items={[]}
      onBeforeShow={(event) => {
        if (!presented()) {
          event.preventDefault();
        }
      }}
      ref={(handle) => {
        menu = handle;
      }}
    >
      <>
        <Show
          when={props.publication}
          fallback={
            <Show when={props.branch.createUrl}>
              {(url) => (
                <a
                  ref={createLinkRef}
                  class="oc-menu-item"
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t("chat.pullRequests.createPrLabel", { branch: props.branch.branch })}
                >
                  <span class="oc-menu-item__icon">
                    <Icon name="externalLink" />
                  </span>
                  {t("chat.pullRequests.createPr")}
                </a>
              )}
            </Show>
          }
        >
          {(publication) => (
            <div class="chat-pr-branch-menu__publication">
              <GitHubPublicationAction
                publication={publication()}
                presented={presented()}
                menuControls
                controls={controls}
              />
              <GitHubPublicationDetails
                publication={publication()}
                menuControls
                controls={controls}
              />
            </div>
          )}
        </Show>
        <StatusWarning status={props.status} />
        <Show when={props.onDismiss}>
          <div class="chat-pr-menu__group">
            <button
              ref={dismissRef}
              class="oc-menu-item"
              data-variant="danger"
              type="button"
              disabled={props.publication?.activity != null}
              aria-label={t("chat.pullRequests.dismissBranch", { branch: props.branch.branch })}
              onClick={() => {
                menu?.close();
                props.onDismiss?.(props.branch);
              }}
            >
              <span class="oc-menu-item__icon">
                <Icon name="eyeOff" />
              </span>
              {t("chat.pullRequests.hide")}
            </button>
          </div>
        </Show>
      </>
    </Menu>
  );
}

export function ChatPullRequestsContent(props: ChatPullRequestsProps) {
  const published = () =>
    props.publication?.result?.status === "published" ? props.publication.result : undefined;
  const retained = () => retainedPublication(props.publication);
  const branch = () => (props.branchDismissed ? undefined : props.branch);
  const workRow = () => showWorkRow(props);
  const recovery = () =>
    retained() && (!published() || props.publication?.error) ? props.publication : undefined;
  return (
    <Show when={hasChatPullRequests(props)}>
      <div class="chat-prs" aria-live="polite">
        <Show
          when={workRow()}
          fallback={
            <>
              <ReadRows {...props} />
              <Show when={recovery()}>
                {(publication) => (
                  <PublicationRecovery publication={publication()} presented={props.presented} />
                )}
              </Show>
            </>
          }
        >
          <WorkRow
            compact={props.compact}
            branch={branch()}
            status={props.status}
            onOpenSessionDiff={props.onOpenSessionDiff}
            publication={props.publication}
            onDismissBranch={props.onDismissBranch}
            presented={props.presented}
          />
        </Show>
      </div>
    </Show>
  );
}

function ReadRows(props: ChatPullRequestsProps) {
  const parentPresented = useContext(ContentPresentation);
  const presentation = createMemo(() => projectPresentation(props.presented ?? true));
  return repositoryReadView(
    mountPullRequestRows,
    () => ({
      pullRequests: props.pullRequests,
      sessionKey: props.sessionKey,
      sessionId: props.sessionId,
      presented: parentPresented() && presentation().read(),
      compact: props.compact,
      dismissed: props.dismissed,
      status: props.status ?? "ready",
      dismissDisabled:
        props.publication?.result?.status === "published" && props.publication.activity !== null,
      onDismiss: (request) => {
        if (props.publication?.result?.status === "published") {
          props.publication.onNewAction?.();
        }
        props.onDismiss(request);
      },
    }),
    repositoryReadCi(() => props.gateway),
  );
}

function PublicationRecovery(props: {
  publication: GitHubPublicationView;
  presented?: PresentationValue;
}) {
  const failed = () => props.publication.result?.status === "failed";
  const content = () => (
    <div class="chat-pr__publication-recovery">
      <GitHubPublicationDetails publication={props.publication} inline={failed()} />
      <Show when={props.publication.result?.status !== "published"}>
        <div>
          <GitHubPublicationAction publication={props.publication} presented={props.presented} />
        </div>
      </Show>
    </div>
  );
  // A session receipt has no proven relationship to any listed PR.
  return (
    <Show when={failed()} fallback={content()}>
      <details class="chat-pr__publication-history">
        <summary>{t("githubPublication.failedAttempt")}</summary>
        {content()}
      </details>
    </Show>
  );
}
