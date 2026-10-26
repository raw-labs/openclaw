import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiRepositorySearchResult } from "../../../../packages/gateway-protocol/src/plugin-control-ui-repositories.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import { PICKER_INPUT_DEBOUNCE_MS } from "./place-browser-state.ts";

function remoteSearch() {
  vi.useFakeTimers();
  const fixture = createRepositoryFixture();
  const { gateway, context, browser } = fixture;
  Object.assign(gateway, {
    connected: true,
    client: context.gateway.snapshot.client,
    connectionEpoch: 1,
  });
  onTestFinished(() => browser.disconnect());
  return fixture;
}

const result: ControlUiRepositorySearchResult = {
  credential: "configured",
  projects: [
    {
      name: "current",
      fullName: "example/current",
      webUrl: "https://git.example/example/current",
      private: false,
      cloneUrl: "https://git.example/example/current.git",
    },
  ],
};

afterEach(() => vi.useRealTimers());

describe("repository source search", () => {
  it("keeps the current query when an earlier query fails later", async () => {
    const { browser, request } = remoteSearch();
    const previous = createDeferred<ControlUiRepositorySearchResult>();
    const current = createDeferred<ControlUiRepositorySearchResult>();
    request.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    browser.changeProjectQuery("previous");
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    browser.changeProjectQuery("current");
    expect(browser.repositorySearchGroups).toEqual([]);
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    current.resolve(result);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.repositorySearchGroups[0]?.items).toEqual(result.projects);
    previous.reject(new Error("previous query failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.repositorySearchGroups[0]).toMatchObject({
      items: result.projects,
      error: null,
      loading: false,
    });
  });

  it("records a current failure, recovers on another query, and retires disconnected reads", async () => {
    const { browser, request } = remoteSearch();
    request.mockRejectedValueOnce(new Error("remote search unavailable"));
    browser.changeProjectQuery("failed");
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    expect(browser.repositorySearchGroups[0]?.error).toContain("remote search unavailable");
    request.mockResolvedValueOnce(result);
    browser.changeProjectQuery("current");
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    expect(browser.repositorySearchGroups[0]?.items).toEqual(result.projects);
    const disconnected = createDeferred<ControlUiRepositorySearchResult>();
    request.mockReturnValueOnce(disconnected.promise);
    browser.changeProjectQuery("disconnected");
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    browser.disconnect();
    expect(browser.repositorySearchGroups).toEqual([]);
    disconnected.resolve(result);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.repositorySearchGroups).toEqual([]);
  });
});
