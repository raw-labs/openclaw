import type { SessionCatalogPullRequestSummary } from "openclaw/plugin-sdk/session-catalog";
import { sessionPullRequestStateIcons } from "./session-pull-request-presentation.ts";
export function projectSidebarBadge(
  summary: SessionCatalogPullRequestSummary | undefined,
  observedCount: number | undefined,
  t: (key: string, params?: Record<string, string>) => string,
) {
  if (!summary && !observedCount) {
    return undefined;
  }
  const label = summary
    ? `${summary.numbers.map((number) => `#${number}`).join(", ")} · ${t(`chat.pullRequests.${summary.state}`)}`
    : undefined;
  const count = observedCount ?? summary?.numbers.length ?? 0;
  return {
    label: [
      count > 1 || !label ? t("sessionsView.pullRequestCount", { count: String(count) }) : "",
      label,
    ]
      .filter(Boolean)
      .join(" · "),
    icon: summary ? sessionPullRequestStateIcons[summary.state] : ("gitPullRequest" as const),
    state: summary?.state,
    count: count > 1 ? count : undefined,
  };
}
