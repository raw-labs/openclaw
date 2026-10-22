import type { ControlUiComponentHandle } from "./control-ui-components.js";
export type ControlUiIconProps = { name: string; className?: string };
export type ControlUiMarqueeOptions = {
  delay?: number;
  speed?: number;
  loop?: boolean;
  host?: () => HTMLElement | undefined;
  stationary?: boolean;
  stationaryWithoutHost?: boolean;
};
export type ControlUiMenuControls = {
  readonly elements: ReadonlySet<HTMLElement>;
  ref(this: void): (element: HTMLElement) => void;
};
export type ControlUiMenuHandle = {
  readonly overlay: { readonly trigger: HTMLElement | undefined; readonly open: boolean };
  close: () => boolean;
};
/** Host-owned attributes are forwarded unchanged to the plugin-rendered root control. */
export type ControlUiMenuItemAttributes = object;
export type ControlUiMenuEntry =
  | { kind: "content"; id: string; content: HTMLElement }
  | { kind: "group"; id: string; className?: string; items: readonly ControlUiMenuEntry[] }
  | {
      kind?: "item";
      id: string;
      label: string;
      className?: string;
      type?: "radio" | "checkbox";
      checked?: boolean;
      disabled?: boolean;
      content?: HTMLElement;
      details?: HTMLElement;
      icon?: HTMLElement;
      href?: string;
      attributes?: {
        target?: string;
        rel?: string;
        [name: `data-${string}`]: string | number | boolean | undefined;
      };
      closeOnSelect?: boolean;
      variant?: "danger";
      render?: (attributes: ControlUiMenuItemAttributes) => HTMLElement;
    };
export type ControlUiMenuProps = {
  id: string;
  className?: string;
  panelClass?: string;
  placement?: "top-end" | "bottom-end";
  label: string;
  disabled?: boolean;
  triggerClass?: string;
  triggerAttributes?: { [name: `data-${string}`]: string | undefined };
  trigger: HTMLElement;
  content?: HTMLElement;
  controls?: ControlUiMenuControls;
  items: readonly ControlUiMenuEntry[];
  presented: boolean;
  ref?: (handle: ControlUiMenuHandle) => void;
  onBeforeShow?: (event: Event) => void;
  onOpenChange?: (open: boolean) => void;
  onEscape?: () => boolean;
  onSelect: (id: string) => void;
};
export type ControlUiActivityPillView = {
  label: string;
  icon: string;
  tone?: "normal" | "muted" | "ok" | "warn" | "danger" | "purple";
  badge?: {
    icon: string;
    tone: "normal" | "muted" | "ok" | "warn" | "danger" | "purple";
    label: string;
  };
  attention?: boolean;
  shine?: boolean;
  count?: string;
  description?: string;
};
/** Shared visual controls and locale services, scoped to one native UI owner. */
export type ControlUiPresentationHost = {
  readonly apiVersion: 1;
  subscribe: (listener: () => void) => () => void;
  translate: (key: string, params?: Record<string, string>) => string;
  mountIcon: (
    container: HTMLElement,
    props: ControlUiIconProps,
  ) => ControlUiComponentHandle<ControlUiIconProps>;
  mountMenu: (
    container: HTMLElement,
    props: ControlUiMenuProps,
  ) => ControlUiComponentHandle<ControlUiMenuProps>;
  /** Shared clipped-text behavior; the plugin retains the element and its copy. */
  mountTextOverflow: (
    element: HTMLElement,
    props: { content: unknown },
  ) => ControlUiComponentHandle<{ content: unknown }>;
  copyText: (value: string, isCurrent: () => boolean) => Promise<boolean>;
  notify: (message: string) => void;
  mountMarquee: (
    container: HTMLElement,
    props: { content: HTMLElement; className: string; options: ControlUiMarqueeOptions },
  ) => ControlUiComponentHandle<{
    content: HTMLElement;
    className: string;
    options: ControlUiMarqueeOptions;
  }>;
  mountTooltip: (
    container: HTMLElement,
    props: { content: string; child: HTMLElement; disabled?: boolean },
  ) => ControlUiComponentHandle<{ content: string; child: HTMLElement; disabled?: boolean }>;
};
