import type { ApplicationContext } from "../../app/context.ts";
import { availableLinkPreviewReaders } from "../../app/link-reader-routing.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import "../../components/link-reader-hovercard-registration.ts";
import { PluginContributions } from "../../plugins/control-ui-contributions.solid.tsx";

/** Activity extensions use the same admitted link readers as other host content. */
export function ActivitySessionAccessories(props: {
  context: ApplicationContext;
  sessionKey?: string;
  agentId?: string;
}) {
  const gateway = projectGateway(props.context.gateway);
  return (
    <openclaw-link-reader-hovercard-provider
      prop:client={gateway.read().snapshot.client}
      prop:readers={availableLinkPreviewReaders(gateway.read().snapshot)}
      prop:agentId={props.agentId ?? ""}
      prop:sessionKey={props.sessionKey}
    >
      <PluginContributions
        kind="session-activity"
        sessionKey={props.sessionKey ?? ""}
        agentId={props.agentId}
        presented={true}
      />
    </openclaw-link-reader-hovercard-provider>
  );
}
