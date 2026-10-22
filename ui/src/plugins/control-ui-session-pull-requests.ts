import type {
  ControlUiDisposer,
  ControlUiSessionPullRequestReads,
} from "../../../src/plugin-sdk/control-ui.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import { sessionPullRequestsForGateway } from "../lib/session-pull-requests.ts";
import { scopedSessionArtifactKey } from "../lib/sessions/session-key.ts";

// UI-F removes this port when this same store and its remaining native consumers
// transfer together. Until then it owns no cache or Gateway subscription set.
export function createControlUiSessionPullRequestReads(params: {
  current: () => { gateway: ApplicationGateway };
  isCurrent: () => boolean;
  retain: (dispose: ControlUiDisposer) => ControlUiDisposer;
}): ControlUiSessionPullRequestReads {
  return {
    apiVersion: 1,
    read: (target) =>
      sessionPullRequestsForGateway(params.current().gateway).get(
        scopedSessionArtifactKey(target.sessionKey, target.agentId),
      ),
    observe(target, changed) {
      const store = sessionPullRequestsForGateway(params.current().gateway);
      const token = {};
      let live = true;
      const stop = store.subscribe(() => {
        if (live && params.isCurrent()) {
          changed();
        }
      });
      const dispose = params.retain(() => {
        if (live) {
          live = false;
          stop();
          store.unwatch(token);
        }
      });
      store.watch(token, [scopedSessionArtifactKey(target.sessionKey, target.agentId)], {
        foreground: true,
      });
      return dispose;
    },
  };
}
