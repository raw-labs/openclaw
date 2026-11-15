import { afterEach, expect, it, vi } from "vitest";
import { preparePluginToolGatewayCapability } from "./plugin-tool-gateway.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import * as transport from "./tools/in-process-gateway.js";

afterEach(() => vi.restoreAllMocks());

it("dispatches only owned Gateway methods for the current admitted caller", async () => {
  const dispatch = vi
    .spyOn(transport, "callInProcessGatewayTool")
    .mockResolvedValue({ state: "ready" });
  const caller = { agentId: "main", sessionKey: "agent:main:owned" };
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("Invocation retired");
    }
  };
  const bind = preparePluginToolGatewayCapability(undefined, caller);
  const gateway = bind(assertCurrent, undefined, ["example.status"]);
  const observe = () => gateway.call("example.status", { sessionKey: caller.sessionKey });

  // Outside an admitted invocation the capability has no caller to act for.
  await expect(observe()).rejects.toThrow("current admitted agent session");
  await withGatewayToolCallerIdentity(caller, async () => {
    await expect(observe()).resolves.toEqual({ state: "ready" });
    await expect(gateway.call("config.set", {})).rejects.toThrow("owned Gateway method");
    await expect(bind(assertCurrent, undefined, []).call("example.status", {})).rejects.toThrow(
      "owned Gateway method",
    );
    current = false;
    await expect(observe()).rejects.toThrow("Invocation retired");
  });
  await withGatewayToolCallerIdentity({ ...caller, sessionKey: "agent:main:other" }, async () => {
    current = true;
    await expect(observe()).rejects.toThrow("current admitted agent session");
  });
  expect(dispatch).toHaveBeenCalledOnce();
});
