import { expect, it } from "vitest";
import { projectSidebarBadge } from "./sidebar-badge-presentation.ts";
it.each([
  { state: "open", numbers: [111532], label: "#111532 · Open" },
  { state: "draft", numbers: [107302], label: "#107302 · Draft" },
  {
    state: "merged",
    numbers: [111751, 111772],
    label: "2 pull requests · #111751, #111772 · Merged",
  },
] as const)(
  "retains catalog PR labels after the policy transfer ($state)",
  ({ state, numbers, label }) => {
    const badge = projectSidebarBadge({ numbers: [...numbers], state }, undefined, (key, params) =>
      key === "sessionsView.pullRequestCount"
        ? `${params?.count} pull requests`
        : state[0]!.toUpperCase() + state.slice(1),
    );
    expect(badge?.label).toBe(label);
    expect(badge?.state).toBe(state);
    expect(badge?.icon).toBeTruthy();
  },
);
