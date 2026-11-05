import { describe, expect, it } from "vitest";
import { prepareGitHubPublisher } from "./publication-publisher-api.js";
import type { PreparedGitHubPublicationIdentity } from "./tool-identity-api.js";

const selected = {
  source: "agent-override" as const,
  profileId: "managed-fixture",
  account: { accountId: 42, login: "fixture-user" },
};

describe("native GitHub publisher provenance", () => {
  it("replays the recorded selection without a caller-owned codec and refreshes the same account", async () => {
    let identity: PreparedGitHubPublicationIdentity = {
      ...selected,
      account: { ...selected.account, avatarUrl: null },
      env: {},
    };
    const publisher = await prepareGitHubPublisher("fixture-agent", selected, {
      prepare: async () => identity,
      isCurrent: () => true,
    });
    expect(publisher.provenance).toEqual(selected);
    identity = { ...identity, account: { ...identity.account, login: "FIXTURE-USER" } };
    await expect(publisher.refresh()).resolves.toBeUndefined();
    expect(publisher.provenance).toEqual(selected);
    identity = { ...identity, account: { ...identity.account, accountId: 43 } };
    await expect(publisher.refresh()).rejects.toThrow("publication identity changed");
  });

  it("rejects replay against a different recorded profile", async () => {
    await expect(
      prepareGitHubPublisher(
        "fixture-agent",
        { ...selected, profileId: "other-profile" },
        {
          prepare: async () => ({
            ...selected,
            account: { ...selected.account, avatarUrl: null },
            env: {},
          }),
          isCurrent: () => true,
        },
      ),
    ).rejects.toThrow("publication identity changed");
  });
});
