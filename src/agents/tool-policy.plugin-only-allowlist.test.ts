/**
 * Regression coverage for plugin-only tool allowlist analysis.
 * Confirms plugin group expansion and unknown allowlist reporting.
 */
import { describe, expect, it } from "vitest";
import { filterToolsByPolicy } from "./tool-policy-match.js";
import {
  analyzeAllowlistByToolType,
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  type PluginToolGroups,
} from "./tool-policy.js";

const pluginGroups: PluginToolGroups = {
  all: ["lobster", "workflow_tool"],
  byPlugin: new Map([["lobster", ["lobster", "workflow_tool"]]]),
};
const coreTools = new Set(["read", "write", "exec", "session_status"]);

describe("analyzeAllowlistByToolType", () => {
  it.each(["group:sessions", "group:openclaw"])(
    "preserves plugin and core grants and denials for %s",
    (group) => {
      const tools = [{ name: "repository_publish" }, { name: "session_status" }, { name: "read" }];
      const groups = buildPluginToolGroups({
        tools,
        toolMeta: (tool) =>
          tool.name === "repository_publish"
            ? { pluginId: "repository", policyGroups: [group] }
            : undefined,
      });
      expect(
        filterToolsByPolicy(tools, expandPolicyWithPluginGroups({ allow: [group] }, groups)).map(
          (tool) => tool.name,
        ),
      ).toEqual(["repository_publish", "session_status"]);
      expect(
        filterToolsByPolicy(
          tools,
          expandPolicyWithPluginGroups({ allow: ["*"], deny: [group] }, groups),
        ).map((tool) => tool.name),
      ).toEqual(["read"]);
      expect(
        filterToolsByPolicy(
          tools,
          expandPolicyWithPluginGroups({ allow: [group], deny: ["repository_publish"] }, groups),
        ).map((tool) => tool.name),
      ).toEqual(["session_status"]);
    },
  );

  it("preserves allowlist when it only targets plugin groups", () => {
    const input = { allow: ["group:plugins"] };
    const policy = analyzeAllowlistByToolType(input, pluginGroups, coreTools);
    expect(input).toEqual({ allow: ["group:plugins"] });
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it("keeps allowlist when it mixes plugin and core entries", () => {
    const input = { allow: ["lobster", "read"] };
    const policy = analyzeAllowlistByToolType(input, pluginGroups, coreTools);
    expect(input).toEqual({ allow: ["lobster", "read"] });
    expect(policy.unknownAllowlist).toStrictEqual([]);
  });

  it("ignores empty plugin ids when building groups", () => {
    const groups = buildPluginToolGroups({
      tools: [{ name: "lobster" }],
      toolMeta: () => ({ pluginId: "" }),
    });
    expect(groups.all).toEqual(["lobster"]);
    expect(groups.byPlugin.size).toBe(0);
  });
});
