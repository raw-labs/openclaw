import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { primarySessionPullRequest } from "./session-pull-request-presentation.ts";

/** The host retains native read and external-navigation ownership. */
export function registerOpenPullRequestAction(host: ControlUiHost) {
  const reads = host.sessionPullRequests;
  const presentation = host.presentation;
  if (!reads || !presentation) {
    throw new Error(
      "The GitHub Open PR action requires the current host's PR read and translation services.",
    );
  }
  const label = () => presentation.translate("sessionsView.openPullRequest");
  const current = (target: Parameters<typeof reads.read>[0]) =>
    primarySessionPullRequest(reads.read(target)?.pullRequests ?? []);
  return host.ui.registerAction({
    id: "open-pull-request",
    placement: "session",
    label: label(),
    icon: "gitPullRequest",
    shortcut: "g",
    opensExternal: true,
    observe(target, changed) {
      const stopRead = reads.observe(target, changed);
      const stopHost = host.subscribe(changed);
      return () => {
        stopHost();
        stopRead();
      };
    },
    resolve: (target) => ({ label: label(), hidden: !current(target)?.url }),
    run(context) {
      const url = current(context)?.url;
      if (url) {
        context.host.navigation.openExternal(url);
      }
    },
  });
}
