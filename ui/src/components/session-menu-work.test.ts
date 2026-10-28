import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLoopbackHostname } from "../lib/gateway-locality.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../test-helpers/native-gateways.ts";
import { fetchSessionMenuWork } from "./session-menu-work.ts";

function sessionMenuClient(request: (method: string, params: unknown) => Promise<unknown>) {
  return { request: request as never };
}

beforeEach(() => {
  setNativeGatewayTestState("local");
});

afterEach(() => {
  clearNativeGatewayTestState();
  vi.restoreAllMocks();
});

describe("isLoopbackHostname", () => {
  it.each([
    ["127.0.0.5", true],
    ["[::1]", true],
    ["127.0.0.1.evil.com", false],
  ])("classifies %s as loopback: %s", (hostname, expected) => {
    expect(isLoopbackHostname(hostname)).toBe(expected);
  });
});

describe("fetchSessionMenuWork", () => {
  it.each([
    { name: "plain browser", nativeGateway: null, expectedPath: null },
    { name: "native local gateway", nativeGateway: "local", expectedPath: "/work/trees/demo" },
    { name: "native remote gateway", nativeGateway: "remote", expectedPath: null },
    {
      name: "remote execution node",
      nativeGateway: "local",
      execNode: "build-mac",
      expectedPath: null,
    },
  ] as const)("exposes editor paths only for native-local files: $name", async (testCase) => {
    setNativeGatewayTestState(testCase.nativeGateway);
    const request = vi.fn(async () => ({
      worktrees: [{ id: "wt-1", path: "/work/trees/demo" }],
    }));

    await expect(
      fetchSessionMenuWork({
        client: sessionMenuClient(request),
        worktreeId: "wt-1",
        execNode: "execNode" in testCase ? testCase.execNode : undefined,
      }),
    ).resolves.toEqual({
      worktreePath: testCase.expectedPath,
    });
    expect(request).toHaveBeenCalledTimes(testCase.expectedPath ? 1 : 0);
  });

  it("hides removed checkout paths and failed lookups", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("offline")));
    await expect(
      fetchSessionMenuWork({
        client: sessionMenuClient(failing),
        worktreeId: "wt-1",
      }),
    ).resolves.toEqual({ worktreePath: null });

    const request = vi.fn(() =>
      Promise.resolve({ worktrees: [{ id: "wt-1", path: "/gone", removedAt: 5 }] }),
    );
    await expect(
      fetchSessionMenuWork({
        client: sessionMenuClient(request),
        worktreeId: "wt-1",
      }),
    ).resolves.toEqual({ worktreePath: null });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("worktrees.list", {});
  });
});
