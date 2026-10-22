/** Browser-only contract for trusted native Control UI plugins. No host implementation imports. */
import type {
  AgentSummary,
  BoardGetParams,
  SessionRow,
  SessionsListParams,
} from "@openclaw/gateway-protocol";
import type { ControlUiSessionPullRequestSnapshot } from "../gateway/control-ui-contract.js";
import type { ControlUiComponents } from "./control-ui-components.js";
import type { ControlUiPresentationHost } from "./control-ui-presentation.js";
export { createSessionHeaderLink } from "./control-ui-session-link.js";
export type {
  ControlUiAgentPickerProps,
  ControlUiComponentHandle,
  ControlUiComponents,
  ControlUiDashboardProps,
  ControlUiDialogProps,
} from "./control-ui-components.js";
export type { AgentsWorkspaceGetResult } from "@openclaw/gateway-protocol";
export type { MemorySearchResponse } from "../../packages/memory-host-sdk/src/host/types.js";
export type ControlUiDisposer = () => void;

export type ControlUiConnection = {
  connected: boolean;
  /** Opaque invalidation identity for authorized read projections, never authority. */
  readonly readScopeKey?: string;
  canRead: boolean;
  canWrite: boolean;
  canGrant: boolean;
  canAdmin: boolean;
  assistantAgentId: string | null;
};

export type ControlUiSession = Readonly<
  SessionRow & {
    /** Live activity from the Control UI session owner; absent while activity is unknown. */
    hasActiveRun?: boolean;
  }
>;

export type ControlUiSessionListQuery = Readonly<
  Pick<
    SessionsListParams,
    | "agentId"
    | "search"
    | "archived"
    | "limit"
    | "configuredAgentsOnly"
    | "includeGlobal"
    | "includeUnknown"
    | "excludeDock"
    | "includeDerivedTitles"
    | "includeLastMessage"
  >
>;

export type ControlUiSessionListResult = {
  readonly sessions: readonly ControlUiSession[];
  readonly hasMore?: boolean;
  readonly nextOffset?: number | null;
  readonly totalCount?: number;
};

export type ControlUiSessionListSnapshot = {
  readonly result: ControlUiSessionListResult | null;
  readonly loading: boolean;
  readonly error: string | null;
};

export type ControlUiSessionListSubscription = {
  /** Fetch again; rejects on failure or when this query's lifetime has ended. */
  refresh: () => Promise<void>;
  dispose: ControlUiDisposer;
};

/** Borrowed presentation facts from the host's existing connection-scoped read owner. */
export type ControlUiSessionPullRequestReads = {
  readonly apiVersion: 1;
  read: (target: BoardGetParams) => ControlUiSessionPullRequestSnapshot | undefined;
  observe: (target: BoardGetParams, changed: () => void) => ControlUiDisposer;
};

export type ControlUiAgent = Readonly<AgentSummary>;
export type ControlUiPageTarget = {
  id: string;
  params?: Readonly<Record<string, string>>;
  /** Unescaped path segments for a page with an advertised native route placement. */
  path?: readonly string[];
};
export type ControlUiPageNavigationOptions = {
  /** Replace the current history entry when canonicalizing a page or changing its filters. */
  replace?: boolean;
  /** Retain the current query, with target parameters taking precedence. */
  preserveSearch?: boolean;
};

export type ControlUiSurfaceProps = {
  "session-list": BoardGetParams & { sessions: readonly ControlUiSession[] };
  composer: BoardGetParams & {
    agentId: string;
    draft: string;
    canSend: boolean;
    sending: boolean;
    disabledReason: string | null;
    setDraft: (text: string) => void;
    /** Resolves true on admission, false on rejection, or void for a local command/no submit. */
    send: () => Promise<boolean | void>;
    abort?: () => void;
  };
  workspace: BoardGetParams & { routeId: string };
  transcript: BoardGetParams & {
    messages: readonly unknown[];
    stream: string | null;
    loading: boolean;
  };
  "tool-result": BoardGetParams & {
    toolName: string;
    toolCallId: string;
    input: unknown;
    output: unknown;
    expanded: boolean;
  };
};

export type ControlUiSurface = keyof ControlUiSurfaceProps;

export type ControlUiViewContext<T = Readonly<Record<string, string>>> = {
  readonly host: ControlUiHost;
  readonly signal: AbortSignal;
  readonly props: T;
  /** Presentation can pause a retained view without ending its host lifetime. */
  readonly presented: boolean;
  /** Mount the host's built-in view inside a replacement; it keeps receiving host updates. */
  mountDefault: (container: HTMLElement) => ControlUiDisposer;
};

export type ControlUiView<T = Readonly<Record<string, string>>> = (
  container: HTMLElement,
  context: ControlUiViewContext<T>,
) => {
  update?: (context: ControlUiViewContext<T>) => void;
  focus?: () => void;
  dispose?: ControlUiDisposer;
} | void;

export type ControlUiPage = {
  id: string;
  label: string;
  mount: ControlUiView;
};

type ControlUiNavigationAction = {
  id: string;
  label: string;
  icon?: string;
  destructive?: boolean;
  run: () => void | Promise<void>;
};

export type ControlUiNavigationItem = {
  id: string;
  /** Navigation item ID in this plugin whose active section displays this child. */
  parent?: string;
  label: string;
  page: ControlUiPageTarget;
  icon?: string;
  order?: number;
  /** False offers the destination in the pin editor without adding it to the sidebar. */
  defaultVisible?: boolean;
  /** Context menu actions, available by right-click or the keyboard menu shortcut. */
  actions?: ControlUiNavigationAction[];
};

export type ControlUiPanel = {
  id: string;
  label: string;
  mount: ControlUiView<BoardGetParams>;
};

export type ControlUiAction = {
  id: string;
  label: string;
  placement: "composer" | "header" | "session";
  icon?: string;
  shortcut?: string;
  opensExternal?: boolean;
  /** Display-scoped interest; cleanup ends delivery and releases read interest. */
  observe?: (
    context: BoardGetParams & { session?: ControlUiSession; signal: AbortSignal },
    changed: () => void,
  ) => ControlUiDisposer;
  resolve?: (context: BoardGetParams & { session?: ControlUiSession }) => {
    label?: string;
    disabled?: boolean;
    hidden?: boolean;
  };
  run: (
    context: BoardGetParams & {
      session?: ControlUiSession;
      host: ControlUiHost;
      signal: AbortSignal;
    },
  ) => void | Promise<void>;
};

/** Offsets address UTF-16 code units in one prose run, excluding code and existing links. */
export type ControlUiTextReference = Readonly<{
  start: number;
  end: number;
  url: string;
  label?: string;
}>;
export type ControlUiTextReferenceInput = {
  text: string;
  links: readonly string[];
};
/** Capture immutable facts; publish a new object when resolution changes, even if key is unchanged. */
export type ControlUiTextReferenceSnapshot = Readonly<{
  /** Deterministic identity of the immutable facts captured by resolve. */
  key: string;
  resolve: (input: ControlUiTextReferenceInput) => readonly ControlUiTextReference[];
}>;
export type ControlUiTextReferenceProvider = {
  id: string;
  /** Presentation requires an admitted link reader owned by this same plugin. */
  readerId: string;
  snapshot: (context: BoardGetParams) => ControlUiTextReferenceSnapshot;
  observe?: (
    context: BoardGetParams & { signal: AbortSignal },
    changed: () => void,
  ) => ControlUiDisposer;
};

export type ControlUiAccessory = {
  id: string;
  placement: "session-header";
  mount: ControlUiView<BoardGetParams>;
};

export type ControlUiWidget = {
  id: string;
  label: string;
  mount: ControlUiView<
    BoardGetParams & {
      widget: { name: string; props?: Readonly<Record<string, unknown>> };
      canMutate: boolean;
      canGrant: boolean;
    }
  >;
};

export type ControlUiReplacement<S extends ControlUiSurface = ControlUiSurface> = {
  [Surface in S]: {
    id: string;
    label: string;
    surface: Surface;
    mount: ControlUiView<ControlUiSurfaceProps[Surface]>;
  };
}[S];

export type ControlUiHost = {
  readonly apiVersion: 1;
  readonly pluginId: string;
  readonly signal: AbortSignal;
  readonly basePath: string;
  readonly locale: string;
  redact: (text: string) => string;
  readonly connection: ControlUiConnection;
  readonly components: ControlUiComponents;
  readonly sessionPullRequests?: ControlUiSessionPullRequestReads;
  readonly presentation?: Pick<ControlUiPresentationHost, "translate">;
  /**
   * Native modules share the operator's authenticated Gateway authority.
   * The Gateway enforces connection scopes, not a per-plugin RPC allowlist.
   */
  request: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  /**
   * `session.message` listeners receive complete message bodies. Registration is
   * synchronous, but delivery starts after the Gateway acknowledges full-body
   * interest. In-flight roster events without bodies are skipped during admission;
   * the host never delivers a bodyless `session.message` to a plugin listener.
   */
  onEvent: (event: string, listener: (payload: unknown) => void) => ControlUiDisposer;
  subscribe: (listener: () => void) => ControlUiDisposer;
  sessions: {
    /** The current application roster may be filtered and paginated. */
    readonly rows: readonly ControlUiSession[];
    readonly selectedKey: string;
    normalizeKey: (sessionKey: string) => string;
    refresh: () => Promise<void>;
    /** Fetch and observe an independent query; the first snapshot may have no result. */
    observe: (
      query: ControlUiSessionListQuery,
      listener: (snapshot: ControlUiSessionListSnapshot) => void,
    ) => ControlUiSessionListSubscription;
    open: (session: BoardGetParams) => void;
    create: (params?: {
      agentId?: string;
      label?: string;
      /** Presentation title without a unique label claim. */
      displayName?: string;
      /** Immutable dock surface; preserves the authenticated operator's creator identity. */
      surface?: "plugin-dock";
    }) => Promise<string | null>;
    patch: (
      session: BoardGetParams,
      patch: { label?: string; model?: string | null },
    ) => Promise<void>;
  };
  agents: {
    readonly rows: readonly ControlUiAgent[];
    readonly selectedId: string | null;
    readonly defaultId: string | null;
    readonly scopeId: string | null;
    select: (agentId: string) => void;
    setScope: (agentId: string | null) => void;
    refresh: () => Promise<void>;
  };
  dock?: {
    /** Dock a conversation beside the current page; replaces a conversation dock already open. */
    openSession: (params: {
      sessionKey: string;
      agentId: string;
      /** Dock tab title. */
      label: string;
      /** Untrusted ambient reference data, never instructions or access authority. */
      context?: { page: string; detail?: Readonly<Record<string, string>> };
    }) => void;
    close: () => void;
    readonly openSessionKey: string | null;
  };
  navigation: {
    /** Open an allowed external URL in an isolated new tab. */
    openExternal: (url: string) => void;
    openPage: (target: ControlUiPageTarget, options?: ControlUiPageNavigationOptions) => void;
    pageHref: (
      target: ControlUiPageTarget,
      options?: Pick<ControlUiPageNavigationOptions, "preserveSearch">,
    ) => string;
  };
  ui: {
    /** Refresh contributions whose presentation depends on plugin-owned state. */
    invalidate: () => void;
    registerPage: (page: ControlUiPage) => ControlUiDisposer;
    registerNavigation: (item: ControlUiNavigationItem) => ControlUiDisposer;
    /** Pin an already registered navigation item once; unknown or pinned IDs are a no-op. */
    pinNavigation: (id: string) => void;
    /** Remove this plugin's saved navigation pin; an absent pin is a no-op. */
    unpinNavigation: (id: string) => void;
    /** Whether this plugin's navigation ID is in the saved sidebar entries. */
    isNavigationPinned: (id: string) => boolean;
    registerPanel: (panel: ControlUiPanel) => ControlUiDisposer;
    /** Open an owned registered panel beside the supplied or currently selected session. */
    openPanel: (id: string, session?: BoardGetParams) => void;
    registerAction: (action: ControlUiAction) => ControlUiDisposer;
    registerAccessory: (accessory: ControlUiAccessory) => ControlUiDisposer;
    registerTextReferenceProvider: (provider: ControlUiTextReferenceProvider) => ControlUiDisposer;
    registerWidget: (widget: ControlUiWidget) => ControlUiDisposer;
    registerReplacement: (replacement: ControlUiReplacement) => ControlUiDisposer;
    /** Select an owned replacement, or restore the built-in view for this surface. */
    selectReplacement: (surface: ControlUiSurface, id: string | null) => void;
  };
};

export type ControlUiPlugin = {
  id: string;
  activate: (host: ControlUiHost) => void | ControlUiDisposer | Promise<void | ControlUiDisposer>;
};

export function defineControlUiPlugin(plugin: ControlUiPlugin): ControlUiPlugin {
  return plugin;
}
export type { DoctorMemoryStatusPayload } from "../../packages/gateway-protocol/src/doctor-memory.js";
export type {
  ControlUiSettingsPlacement,
  ControlUiSettingsSnapshot,
  ControlUiContributionSettingsSnapshot,
  ControlUiContributedSettingsView,
  ControlUiSettingsContextV2,
  ControlUiSettingsClient,
  ControlUiSettingsConfigMutation,
  ControlUiSettingsComponents,
  ControlUiSettingsContext,
  ControlUiSettingsView,
  ControlUiChannelSettingsSnapshot,
  ControlUiChannelSettingsContext,
  ControlUiChannelSettingsView,
} from "./control-ui-settings.js";

// Existing Gateway wire facts used by contributed Settings; mutation authority stays with the host.
export type {
  GitHubIdentityFacts,
  ToolsGitHubStatusResult,
  ToolsGitHubAuthorizeStartResult,
  ToolsGitHubAuthorizePollResult,
} from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
export type {
  PersonalGitHubStatus,
  UsersGitHubStatusResult,
  UsersGitHubAuthorizePollResult,
} from "../../packages/gateway-protocol/src/schema/users.js";
export { generateUUID } from "../../packages/normalization-core/src/uuid.js";
export { resolveSafeTimeoutDelayMs } from "../../packages/gateway-client/src/timeouts.js";

// Native controls used by separately owned browser renderers.
export type { ControlUiNativeHost } from "./control-ui-native.js";
export type {
  ControlUiPresentationHost,
  ControlUiIconProps,
  ControlUiMarqueeOptions,
  ControlUiMenuControls,
  ControlUiMenuHandle,
  ControlUiMenuEntry,
  ControlUiMenuItemAttributes,
  ControlUiMenuProps,
  ControlUiActivityPillView,
} from "./control-ui-presentation.js";
export type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../gateway/control-ui-contract.js";
