import { For } from "solid-js";
import type {
  ControlUiContributionSettingsPlacement,
  ControlUiContributionSettingsSnapshot,
} from "../../../src/plugin-sdk/control-ui-settings.js";
import { pathForAgentPanel } from "../app-route-paths.ts";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "../app/operator-access.ts";
import { i18n } from "../i18n/index.ts";
import { currentConfigObject } from "../lib/config/config-state-model.ts";
import { createGatewayConnectionLifecycle } from "../lib/gateway-connection-lifecycle.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { getLocale } from "../lib/reactive/i18n.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import type { ControlUiSettingsContribution } from "./control-ui-metadata.ts";
import { ControlUiSettingsPresentation } from "./control-ui-settings-view.solid.tsx";

type ContributedPlacement = ControlUiContributionSettingsPlacement;

/** Every admitted contribution has its own renderer and lifetime within a shared host slot. */
export function ControlUiSettingsSlot(props: {
  placement: Pick<ContributedPlacement, "section" | "panel">;
}) {
  const application = useApplication();
  const gateway = projectGateway(application.gateway);
  const plugins = projectOwner(application.plugins, (owner) => owner.settingsContributions);
  const connection = createGatewayConnectionLifecycle(application.gateway.snapshot);
  const declarations = () =>
    plugins
      .read()
      .filter(
        (entry): entry is ControlUiSettingsContribution & { placement: ContributedPlacement } => {
          const view = entry.placement;
          return (
            view.section === props.placement.section &&
            view.panel === props.placement.panel &&
            (view.requiredMethods?.every((method) =>
              gateway.read().snapshot.hello?.features?.methods?.includes(method),
            ) ??
              true)
          );
        },
      );
  function readSnapshot(
    entry: ControlUiSettingsContribution,
  ): ControlUiContributionSettingsSnapshot {
    const snapshot = application.gateway.snapshot;
    const auth = snapshot.hello?.auth;
    connection.transition(snapshot);
    return {
      agentId: application.settingsAgentSelection.state.selectedId,
      agentsLoading: application.agents.state.agentsLoading,
      agentsError: application.agents.state.agentsError,
      connected: snapshot.phase === "connected" && snapshot.selfUser !== undefined,
      advertisedMethods: snapshot.hello?.features?.methods,
      connectionEpoch: connection.epoch,
      routeIntent: JSON.stringify([entry.pluginId, entry.revision, entry.placement]),
      locale: getLocale(),
      profile:
        snapshot.selfUser === undefined
          ? undefined
          : snapshot.selfUser
            ? { id: snapshot.selfUser.id }
            : null,
      permissionsReady: snapshot.phase === "connected" && Boolean(snapshot.hello),
      canRead: auth ? hasOperatorReadAccess(auth) : false,
      canAdmin: auth ? hasOperatorAdminAccess(auth) : false,
      agents: application.agents.state.agentsList?.agents,
      configAvailable: currentConfigObject(application.runtimeConfig.state) !== null,
    };
  }
  const subscribe = (listener: () => void) => {
    const stops = [
      application.gateway,
      application.agents,
      application.settingsAgentSelection,
      application.runtimeConfig,
      application.plugins,
    ].map((owner) => owner.subscribe(listener));
    stops.push(i18n.subscribe(listener));
    return () => stops.forEach((stop) => stop());
  };
  return (
    <For each={declarations()} keyed={(entry) => `${entry.pluginId}/${entry.placement.id}`}>
      {(entry) => (
        <ControlUiSettingsPresentation
          application={application}
          pluginId={entry().pluginId}
          placement={entry().placement}
          readSnapshot={() => readSnapshot(entry())}
          subscribe={subscribe}
          refreshAgents={() => {
            void application.agents.ensureList();
          }}
          navigate={() => {}}
          navigateTo={(destination) => {
            if (destination.page === "profile") {
              application.navigate("profile", { hash: destination.hash });
            }
            const agentId = application.settingsAgentSelection.state.selectedId;
            if (destination.page === "agent-tools" && agentId) {
              application.navigate("agents", {
                pathname: pathForAgentPanel(agentId, "tools", application.basePath),
              });
            }
          }}
        />
      )}
    </For>
  );
}
