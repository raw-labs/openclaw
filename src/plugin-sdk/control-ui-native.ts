import type { ControlUiComponentHandle } from "./control-ui-components.js";

/** Native DOM primitives used by independently owned read renderers. */
export type ControlUiNativeHost = {
  mountDiff: (
    container: HTMLElement,
    props: {
      item: { additions?: number; deletions?: number };
      classPrefix: "session-hovercard" | "chat-pr" | "activity-feed";
      onOpen?: () => void;
    },
  ) => ControlUiComponentHandle<{
    item: { additions?: number; deletions?: number };
    classPrefix: "session-hovercard" | "chat-pr" | "activity-feed";
    onOpen?: () => void;
  }>;
  createDisclosureOverlay: (
    id: string,
    details: () => HTMLDetailsElement,
  ) => {
    bind: (surface: HTMLElement, trigger: HTMLElement) => () => void;
    request: (open: boolean) => void;
    subscribe: (notify: (open: boolean) => void) => () => void;
    dispose: () => void;
  };
};
