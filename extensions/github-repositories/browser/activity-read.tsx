/** @jsxImportSource @solidjs/web */
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "@openclaw/gateway-protocol";
import { For, Show } from "solid-js";
import { SessionGitDiff } from "./native-components.tsx";
import { Icon } from "./presentation-components.tsx";
import { presentationTranslator } from "./presentation-context.ts";
import { sessionPullRequestStateIcons } from "./session-pull-request-presentation.ts";

export function ActivityRead(props: {
  branch?: ControlUiSessionBranch;
  pullRequests: readonly ControlUiSessionPullRequest[];
  stale: boolean;
}) {
  const t = presentationTranslator();
  return (
    <div class="activity-feed__git">
      <Show when={props.branch}>
        {(branch) => (
          <span
            class="activity-feed__branch"
            title={t("activity.git.branchDiff", { branch: branch().branch })}
          >
            <span class="activity-feed__git-icon" aria-hidden="true">
              <Icon name="gitBranch" />
            </span>
            <span class="activity-feed__git-label">{branch().branch}</span>
            <SessionGitDiff classPrefix="activity-feed" item={branch()} />
          </span>
        )}
      </Show>
      <For each={props.pullRequests} keyed={(pr) => pr.url}>
        {(pr) => (
          <a
            class="activity-feed__pr"
            data-state={pr().state}
            href={pr().url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("activity.git.pullRequest", {
              repository: `${pr().owner}/${pr().repo}`,
              number: String(pr().number),
              title: pr().title,
              state: t(`activity.git.${pr().state}`),
            })}
          >
            <span class="activity-feed__git-icon" aria-hidden="true">
              <Icon name={sessionPullRequestStateIcons[pr().state]} />
            </span>
            <span class="activity-feed__git-label">
              {pr().repo}#{pr().number}
            </span>
            <SessionGitDiff classPrefix="activity-feed" item={pr()} />
          </a>
        )}
      </For>
      <Show when={props.stale}>
        <span
          class="activity-feed__git-stale"
          role="img"
          aria-label={t("activity.git.stale")}
          title={t("activity.git.stale")}
        >
          <Icon name="alertTriangle" />
        </span>
      </Show>
    </div>
  );
}
