/** @jsxImportSource @solidjs/web */
import type {
  ControlUiComponentHandle,
  ControlUiMenuControls,
  ControlUiSessionPullRequest,
} from "openclaw/plugin-sdk/control-ui";
import { createContext, useContext } from "solid-js";
import { hostControl } from "./host-control.tsx";

export type CiReadProps = {
  pullRequest?: ControlUiSessionPullRequest;
  sessionKey: string;
  sessionId?: string;
  presented: boolean;
  inline?: boolean;
  menuControls?: boolean;
  menuPresentation?: boolean;
  controls?: ControlUiMenuControls;
};

/** Existing native CI owners keep request and write custody during this presentation cut. */
export type CiReadServices = {
  mountDetails: (
    container: HTMLElement,
    props: CiReadProps,
  ) => ControlUiComponentHandle<CiReadProps>;
  mountAutomation: (
    container: HTMLElement,
    props: CiReadProps,
  ) => ControlUiComponentHandle<CiReadProps>;
};

export const CiReadContext = createContext<CiReadServices | undefined>(undefined);

export function CiDetails(props: CiReadProps) {
  return hostControl(() => ({ ...props }), services().mountDetails);
}

export function CiAutomation(props: CiReadProps) {
  return hostControl(() => ({ ...props }), services().mountAutomation);
}

function services() {
  const current = useContext(CiReadContext);
  if (!current) {
    throw new Error("This read view requires the native CI owner.");
  }
  return current;
}
