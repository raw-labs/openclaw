import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
  ControlUiPresentationHost,
  ControlUiActivityPillView,
} from "openclaw/plugin-sdk/control-ui";
type Translate = ControlUiPresentationHost["translate"];
type PillView = ControlUiActivityPillView;
type Badge = NonNullable<PillView["badge"]>;
const prIcons = {
  open: "gitPullRequest",
  draft: "gitPullRequestDraft",
  merged: "gitMerge",
  closed: "gitPullRequestClosed",
} as const;
const prTones = { open: "ok", draft: "muted", merged: "purple", closed: "danger" } as const;

export function pullRequestView(
  pr: ControlUiSessionPullRequest,
  status: ControlUiSessionPullRequestSnapshot["status"],
  t: Translate,
): PillView {
  const checks =
    (pr.state === "open" || pr.state === "draft") && status === "ready" ? pr.checks : undefined;
  const badge: Badge | undefined = checks
    ? {
        icon: checks.state === "pending" ? "spinner" : checks.state === "passing" ? "check" : "x",
        tone: checks.state === "passing" ? "ok" : checks.state === "failing" ? "danger" : "normal",
        label:
          checks.state === "passing"
            ? t("chat.activityPills.pullRequest.checksPassed")
            : checks.state === "failing"
              ? t("chat.activityPills.pullRequest.checksFailed")
              : t("chat.activityPills.pullRequest.checksRunning"),
      }
    : undefined;
  const query =
    status === "ready"
      ? ""
      : status === "rate-limited"
        ? t("chat.activityPills.pullRequest.rateLimitedSuffix")
        : t("chat.activityPills.pullRequest.unavailableSuffix");
  return {
    label: t("chat.activityPills.pullRequest.number", { number: String(pr.number) }),
    icon: prIcons[pr.state],
    tone: prTones[pr.state],
    badge,
    attention: status === "unavailable",
    description: t("chat.activityPills.pullRequest.description", {
      owner: pr.owner,
      repo: pr.repo,
      number: String(pr.number),
      title: pr.title,
      state: t(`chat.activityPills.pullRequest.states.${pr.state}`),
      checks: badge
        ? t("chat.activityPills.pullRequest.checksSuffix", { checks: badge.label })
        : "",
      query,
    }),
  };
}
