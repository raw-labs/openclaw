import type { SessionRow, BoardGetParams } from "@openclaw/gateway-protocol";

/** Host custody preserves an admitted operation across detached presentations. */
export type ControlUiSessionOperationOwner = {
  client: {
    request: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  };
  target: BoardGetParams;
  isCurrent: () => boolean;
  reserve: () => void;
  release: () => void;
  unbound: () => void;
};
export type ControlUiSessionOperation<TBinding> = {
  readonly hasBindings: boolean;
  bind: () => TBinding & { detach: () => void };
  reset: () => void;
  invalidate: () => void;
  observeEvent?: (event: string, payload: unknown, row: SessionRow) => void;
};
export type ControlUiSessionOperationFactory<TBinding> = {
  /** Stable within a plugin; a new implementation must reject old instances in isOperation. */
  id: string;
  requiredMethods: readonly string[];
  create: (owner: ControlUiSessionOperationOwner) => ControlUiSessionOperation<TBinding>;
  isOperation: (value: unknown) => value is ControlUiSessionOperation<TBinding>;
  capacityError: () => Error;
};
export type ControlUiSessionOperationBinding<TBinding> = TBinding & {
  detach: () => void;
  matches: (row: SessionRow) => boolean;
};
