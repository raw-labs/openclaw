import type { prepareHostMcpToolsForAttempt } from "../agent-bundle-mcp-harness.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

type Prepare = Parameters<typeof prepareHostMcpToolsForAttempt>[0];

/** Bind host MCP acquisition to the same request lifetime as the regular tool surface. */
export function bindHostMcpToolPreparation(
  host: {
    attempt: Prepare["attempt"];
    hostMcpApps?: boolean;
    toolCalls?: "deny";
  },
  withCaller: <T>(run: () => Promise<T>) => Promise<T>,
  options: Omit<Prepare, "attempt" | "reservedToolNames">,
): AgentHarnessHostCapabilities["prepareHostMcpTools"] {
  if (!host.hostMcpApps || host.toolCalls === "deny") {
    return undefined;
  }
  const { attempt } = host;
  return async (reservedToolNames) => {
    options.assertCurrent();
    const { prepareHostMcpToolsForAttempt: prepare } =
      await import("../agent-bundle-mcp-harness.js");
    return await withCaller(() => prepare({ ...options, attempt, reservedToolNames }));
  };
}
