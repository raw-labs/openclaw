import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { readGitHubConfig } from "./config-api.js";
import {
  identity,
  NEW_PROFILE,
  OLD_PROFILE,
  OTHER_PROFILE,
} from "./github-oauth-lifecycle.test-support.js";
import {
  configuredOAuthIdentities,
  captureGitHubOAuthAuthorizationIdentity,
} from "./oauth-lifecycle-helpers-api.js";

describe("GitHub OAuth maintenance inventory", () => {
  it("bounds roster reads while preserving ordered identities and fresh configuration", () => {
    const count = 128;
    const entries: Record<string, Record<string, never>> = {};
    for (let index = count; index > 0; index -= 1) {
      entries[`agent-${String(index).padStart(3, "0")}`] = {};
    }
    let reads = 0;
    const observed = new Proxy(entries, {
      get(target, key, receiver) {
        reads += typeof key === "string" && Object.hasOwn(target, key) ? 1 : 0;
        return Reflect.get(target, key, receiver);
      },
    });
    const config: OpenClawConfig = { agents: { entries: observed } };
    expect(configuredOAuthIdentities(config)).toEqual([]);
    // Idle maintenance should traverse a large roster a bounded number of times.
    expect(reads).toBeLessThanOrEqual(count * 4);

    const system = identity(OLD_PROFILE, { oauth: true, author: true });
    const agent = identity(NEW_PROFILE, { oauth: true, author: true });
    config.plugins = { entries: { "github-repositories": { config: {} } } };
    const plugin = readGitHubConfig(config);
    plugin.system = system;
    plugin.agents = {
      "agent-128": agent,
      "agent-064": system,
      "agent-001": identity(OTHER_PROFILE),
    };
    expect(configuredOAuthIdentities(config)).toEqual([
      { scope: "system", agentId: "system", identity: system },
      { scope: "agent", agentId: "agent-064", identity: system },
      { scope: "agent", agentId: "agent-128", identity: agent },
    ]);
    plugin.agents["agent-001"] = agent;
    delete entries["agent-128"];
    expect(configuredOAuthIdentities(config)).toEqual([
      { scope: "system", agentId: "system", identity: system },
      { scope: "agent", agentId: "agent-001", identity: agent },
      { scope: "agent", agentId: "agent-064", identity: system },
    ]);
  });
});

it("never captures a GitHub App signing key in OAuth device authorization state", () => {
  const config: OpenClawConfig = {
    tools: {},
    plugins: {
      entries: {
        "github-repositories": {
          config: {
            system: {
              kind: "app-installation",
              profileId: OLD_PROFILE,
              app: {
                appId: 1,
                installationId: 2,
                accountId: 3,
                repositories: [{ id: 4, fullName: "example/project" }],
                permissions: { contents: "read" },
                privateKey: "synthetic-signing-key",
                keyVersion: "synthetic-v1",
              },
            },
          },
        },
      },
    },
  };
  expect(() =>
    captureGitHubOAuthAuthorizationIdentity(config, { scope: "system", agentId: "main" }),
  ).toThrow("before connecting an OAuth identity");
  const oauth = identity(OLD_PROFILE, { oauth: true });
  readGitHubConfig(config).system = oauth;
  const captured = captureGitHubOAuthAuthorizationIdentity(config, {
    scope: "system",
    agentId: "main",
  });
  expect(captured).toEqual(oauth);
  oauth.profileId = NEW_PROFILE;
  expect(captured?.profileId).toBe(OLD_PROFILE);
});
