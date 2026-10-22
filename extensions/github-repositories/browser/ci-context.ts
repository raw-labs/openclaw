import type { ControlUiRequests, ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createContext } from "solid-js";
export const RepositoryCiContext = createContext<{
  requests: ControlUiRequests;
  isPresented: () => boolean;
  isCurrent: (target: {
    sessionKey: string;
    sessionId?: string;
    pullRequest?: { owner: string; repo: string; number: number; headSha?: string };
  }) => boolean;
  agentId: ControlUiHost["sessions"]["agentId"];
}>();
