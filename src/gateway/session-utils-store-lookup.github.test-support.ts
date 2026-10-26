import { onTestFinished, vi } from "vitest";
import * as publicationAvailability from "../../extensions/github-repositories/publication-availability-api.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RepositoryPublicationApi } from "../plugin-sdk/repository-publication-engine.js";
import { installPublicationRpcFixture } from "./github-account-service.test-support.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

export async function createGitHubOptionsLookupContext(config: OpenClawConfig) {
  const prepareIdentity = vi
    .spyOn(publicationAvailability, "prepareCurrentGitHubPublicationOptionsIdentity")
    .mockImplementation(async (agentId) => ({
      source: "system-configured",
      account: {
        accountId: agentId === "research" ? 202 : 101,
        login: `synthetic-${agentId}`,
        avatarUrl: null,
      },
    }));
  onTestFinished(() => {
    prepareIdentity.mockRestore();
  });
  const latestShared = vi.fn<RepositoryPublicationApi["latestShared"]>(async () => null);
  const context = createContext([], () => config);
  await installPublicationRpcFixture(context, { latestShared });
  return { context, latestShared, prepareIdentity };
}
