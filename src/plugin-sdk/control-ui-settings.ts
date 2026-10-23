import type { ControlUiSettingsPlacement } from "../../packages/gateway-protocol/src/plugin-control-ui-settings.js";
import type { ChannelsStatusResult } from "../../packages/gateway-protocol/src/schema/channels.js";
import type { ControlUiComponentHandle } from "./control-ui-components.js";

export type { ControlUiSettingsPlacement };
export type ControlUiSettingsSnapshot = {
  readonly agentId: string | null;
  readonly agentsLoading: boolean;
  readonly agentsError: string | null;
  readonly engine: {
    readonly kind: "default" | "off" | "pinned";
    readonly id: string | null;
    readonly availability: "enabled" | "disabled" | "missing" | "loading" | "unknown";
  };
  readonly connected: boolean;
  /** Gateway-advertised methods; absent until the connection publishes its catalog. */
  readonly advertisedMethods?: readonly string[];
  readonly connectionEpoch: number;
  readonly routeIntent: string;
  readonly locale: string;
};

/** General contribution facts do not require a Memory engine. */
export type ControlUiContributionSettingsSnapshot = Omit<ControlUiSettingsSnapshot, "engine"> & {
  /** Hello authorization can settle before the authenticated profile lookup. */
  readonly permissionsReady?: boolean;
  readonly profile?: { readonly id: string } | null;
  readonly canRead?: boolean;
  readonly canAdmin?: boolean;
  readonly agents?: readonly { id: string; name?: string; identity?: { name?: string } }[];
  readonly configAvailable: boolean;
};

export type ControlUiSettingsClient = {
  request: <T = unknown>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<T>;
};
export type ControlUiSettingsConfigMutation = <T>(
  task: (client: ControlUiSettingsClient) => Promise<T>,
  options?: {
    canDispatch?: () => boolean;
    dispatchError?: string;
    shouldRefresh?: (value: T) => boolean;
  },
) => Promise<
  | { ok: true; value: T; refresh: { ok: true } | { ok: false; error: string } }
  | {
      ok: false;
      reason: "conflict" | "error" | "rejected" | "suspended" | "unavailable";
      error: string;
    }
>;

type Content = string | HTMLElement;
type SectionProps = {
  title: Content;
  description?: Content;
  actions?: Content;
  danger?: boolean;
  content: HTMLElement;
};
type RowProps = { title: Content; description?: Content; control?: Content };
type StatusProps = { kind: "ok" | "warn" | "danger" | "accent" | "muted"; label: string };
type ValueProps = { value: string | number; mono?: boolean };
type NavProps = { title: string; onClick: () => void };
type SecretInputProps = {
  ariaLabel: string;
  value: string;
  placeholder?: string;
  visible: boolean;
  disabled?: boolean;
  showLabel: string;
  hideLabel: string;
  toggleLabel: string;
  onInput: (value: string) => void;
  onToggle: () => void;
};
type SegmentedProps = {
  value: string;
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
  ariaLabel?: string;
  onChange: (value: string) => void;
};
type PetProps = {
  seed: string;
  sleeping?: boolean;
  reading?: boolean;
  grumpy?: boolean;
  standalone?: boolean;
};

/** Consumed by Settings presentations; the shipped ControlUiComponents contract is unchanged. */
export type ControlUiSettingsComponents = {
  mountSection: (
    container: HTMLElement,
    props: SectionProps,
  ) => ControlUiComponentHandle<SectionProps>;
  mountRow: (container: HTMLElement, props: RowProps) => ControlUiComponentHandle<RowProps>;
  mountStatus: (
    container: HTMLElement,
    props: StatusProps,
  ) => ControlUiComponentHandle<StatusProps>;
  mountValue: (container: HTMLElement, props: ValueProps) => ControlUiComponentHandle<ValueProps>;
  mountNavigation: (container: HTMLElement, props: NavProps) => ControlUiComponentHandle<NavProps>;
  mountSecretInput?: (
    container: HTMLElement,
    props: SecretInputProps,
  ) => ControlUiComponentHandle<SecretInputProps>;
  mountSegmented?: (
    container: HTMLElement,
    props: SegmentedProps,
  ) => ControlUiComponentHandle<SegmentedProps>;
  mountIcon?: (
    container: HTMLElement,
    props: { name: "copy" },
  ) => ControlUiComponentHandle<{ name: "copy" }>;
  mountLobster: (container: HTMLElement, props: PetProps) => ControlUiComponentHandle<PetProps>;
};

export type ControlUiSettingsContext = {
  readonly apiVersion?: 2;
  readonly signal: AbortSignal;
  readonly props: ControlUiSettingsSnapshot;
  readonly components: ControlUiSettingsComponents;
  /** Existing authenticated operator RPC authority, bound to this Settings lifetime. */
  request: <T = unknown>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<T>;
  navigate: (destination: "overview" | "memories" | "dreams" | "settings") => void;
  registerEnglish?: (catalog: Record<string, Record<string, string>>) => void;
  copyButton?: (
    event: Event,
    text: string,
    idleLabel: string,
    targets: { label?: HTMLElement; feedback?: HTMLElement },
  ) => Promise<boolean>;
  navigateTo?: (destination: { page: "profile" | "agent-tools"; hash?: string }) => void;
  /** The config owner serializes and refreshes an external config mutation. */
  runConfigMutation?: ControlUiSettingsConfigMutation;
  ensureConfig?: () => Promise<void>;
  confirm?: (options: { title: string; message: string; confirmLabel: string }) => Promise<boolean>;
  translate?: (key: string, params?: Record<string, string>) => string;
  formatExternalText?: (value: string | null | undefined, fallback?: string) => string;
  formatDateTime?: (timestamp: number, options?: Intl.DateTimeFormatOptions) => string;
  refreshAgents: () => void;
  formatRelativeTimestamp: (timestamp: number) => string;
  formatError: (error: unknown) => string;
};

/** Scoped Settings mutation/presentation services supplied by the current host. */
export type ControlUiSettingsContextV2 = Omit<ControlUiSettingsContext, "props"> & {
  readonly props: ControlUiContributionSettingsSnapshot;
  readonly apiVersion: 2;
  /** Read the existing config owner; no independent config cache or write path. */
  readConfig: (path: readonly string[]) => unknown;
  readAgentConfig: (agentId: string) => { tools?: unknown } | null;
  readonly components: ControlUiSettingsComponents &
    Required<
      Pick<ControlUiSettingsComponents, "mountSecretInput" | "mountSegmented" | "mountIcon">
    >;
} & Required<
    Pick<
      ControlUiSettingsContext,
      | "runConfigMutation"
      | "ensureConfig"
      | "confirm"
      | "translate"
      | "formatExternalText"
      | "formatDateTime"
      | "copyButton"
      | "navigateTo"
      | "registerEnglish"
    >
  >;

export type ControlUiSettingsView = {
  readonly placement: Extract<ControlUiSettingsPlacement, { section: "memory" }>;
  mount: (
    container: HTMLElement,
    context: ControlUiSettingsContext,
  ) => {
    update: (props: ControlUiSettingsSnapshot) => void;
    dispose: () => void;
  };
};

export type ControlUiContributedSettingsView = {
  readonly placement: Extract<ControlUiSettingsPlacement, { section: "profile" | "agents" }>;
  mount: (
    container: HTMLElement,
    context: ControlUiSettingsContextV2,
  ) => {
    update: (props: ControlUiContributionSettingsSnapshot) => void;
    dispose: () => void;
  };
};

export type ControlUiChannelSettingsSnapshot = {
  readonly channelId: string;
  readonly status: unknown;
  readonly defaultAccountId?: string;
  readonly login?: {
    readonly message: string | null;
    readonly qrDataUrl: string | null;
    readonly connected: boolean | null;
    readonly busy: boolean;
  };
  readonly accounts: readonly ChannelsStatusResult["channelAccounts"][string][number][];
  readonly connected: boolean;
  readonly canAdmin: boolean;
  readonly connectionEpoch: number;
  readonly locale: string;
  /** Detaching the channel detail does not end this page-owned editor lifetime. */
  readonly presented: boolean;
};

export type ControlUiChannelSettingsContext = {
  readonly signal: AbortSignal;
  readonly props: ControlUiChannelSettingsSnapshot;
  readonly components: ControlUiSettingsComponents;
  /** Authenticated JSON under this channel's account namespace; no credentials leave the host. */
  request: (request: {
    accountId: string;
    path: readonly string[];
    method: "PUT" | "POST";
    body: unknown;
    signal: AbortSignal;
  }) => Promise<{
    ok: boolean;
    status: number;
    data: Record<string, unknown> | null;
    errorMessage: string;
  }>;
  /** Shared login owner, available only for the declaring channel's existing login flow. */
  login?: {
    start: (force: boolean) => Promise<void>;
    wait: () => Promise<void>;
    /** Capture the current account before an awaited operator decision. */
    captureLogout: () => { readonly accountId: string; logout: () => Promise<void> } | null;
  };
  confirm?: (options: {
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
  }) => Promise<boolean>;
  formatPhoneNumber?: (value: string) => string;
  formatDuration?: (milliseconds: number) => string;
  mountConfig: (container: HTMLElement) => () => void;
  refresh: (probe: boolean) => Promise<void>;
  formatRelativeTimestamp: (timestamp: number | null | undefined) => string;
  formatError: (error: unknown) => string;
  formatExternalText: (text: string) => string;
};

export type ControlUiChannelSettingsView = {
  readonly placement: Extract<ControlUiSettingsPlacement, { section: "channels" }>;
  mount: (
    container: HTMLElement,
    context: ControlUiChannelSettingsContext,
  ) => {
    update: (props: ControlUiChannelSettingsSnapshot) => void;
    dispose: () => void;
  };
};
