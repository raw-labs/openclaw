import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

const yieldingHandoffs = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionToolHandoffYield"),
  () => new AsyncLocalStorage<{ yielding: boolean }>(),
);

/** The abort race observes only the initiating execute call, never concurrent siblings. */
export function runWithSessionToolHandoffYield<T>(run: (isYielding: () => boolean) => T): T {
  const scope = { yielding: false };
  return yieldingHandoffs.run(scope, () => run(() => scope.yielding));
}

export function recordSessionToolHandoffYield(): void {
  const scope = yieldingHandoffs.getStore();
  if (scope) {
    scope.yielding = true;
  }
}

// Core chunks and source-transformed SDK consumers must share the same host receipt owner.
const acceptedHandoffs = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionToolHandoffSettlement"),
  () => new AsyncLocalStorage<WeakSet<object>>(),
);

/** One execute callback may settle only the exact acknowledgment accepted in its own scope. */
export function runWithSessionToolHandoffSettlement<T>(
  run: (isAccepted: (result: unknown) => boolean) => T,
): T {
  const accepted = new WeakSet<object>();
  return acceptedHandoffs.run(accepted, () =>
    run((result) => result !== null && typeof result === "object" && accepted.has(result)),
  );
}

/** Host-only: a yielded turn has transferred this work, not granted further invocation authority. */
export function recordSessionToolHandoffAcceptance(result: object): void {
  acceptedHandoffs.getStore()?.add(result);
}
