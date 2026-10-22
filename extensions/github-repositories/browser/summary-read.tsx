/** @jsxImportSource @solidjs/web */
import type { ControlUiSessionPullRequest } from "openclaw/plugin-sdk/control-ui";
import { For, Show } from "solid-js";
import { presentationTranslator } from "./presentation-context.ts";

export function SummaryRead(props: { pullRequests: readonly ControlUiSessionPullRequest[] }) {
  const t = presentationTranslator();
  const checkLabel = (pr: ControlUiSessionPullRequest) => {
    const checks = pr.checks;
    return checks
      ? t(
          checks.state === "passing"
            ? "chat.rail.checksPassing"
            : checks.state === "failing"
              ? "chat.rail.checksFailing"
              : "chat.rail.checksPending",
          {
            count: String(
              checks.state === "passing"
                ? checks.passed
                : checks.state === "failing"
                  ? checks.failed
                  : checks.running,
            ),
          },
        )
      : null;
  };
  return (
    <div class="chat-session-rail__prs" aria-label={t("chat.rail.pullRequests")}>
      <For each={props.pullRequests.slice(0, 2)} keyed={(pr) => pr.url}>
        {(pr) => (
          <a
            class="chat-session-rail__pr"
            href={pr().url}
            target="_blank"
            rel="noopener noreferrer"
            title={pr().title}
          >
            <span>#{pr().number}</span>
            <span>{t(`chat.pullRequests.${pr().state}`)}</span>
            <Show when={checkLabel(pr())}>
              {(label) => <span class="chat-session-rail__pr-checks">{label()}</span>}
            </Show>
          </a>
        )}
      </For>
    </div>
  );
}
