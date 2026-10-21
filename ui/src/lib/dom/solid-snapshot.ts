import { insert, registerDelegatedRoot, unregisterDelegatedRoot, type JSX } from "@solidjs/web";
import { createRoot, runWithOwner, type getOwner } from "solid-js";
function withSolidRoot<T>(owner: ReturnType<typeof getOwner>, init: (dispose: () => void) => T): T {
  return runWithOwner(owner, () => createRoot(init));
}

/** Own synchronous DOM islands without flushing a caller's commit phase. */
export function mountSolidContent(
  target: HTMLElement,
  view: () => JSX.Element,
  owner: ReturnType<typeof getOwner> = null,
) {
  return withSolidRoot(owner, (dispose) => {
    const start = document.createComment("plugin-content-start"),
      end = document.createComment("plugin-content-end");
    target.append(start, end);
    if (owner === null) {
      registerDelegatedRoot(target);
    }
    let live = true;
    const stop = () => {
      if (!live) {
        return;
      }
      live = false;
      if (owner === null) {
        unregisterDelegatedRoot(target);
      }
      dispose();
      while (start.nextSibling && start.nextSibling !== end) {
        target.removeChild(start.nextSibling);
      }
      start.remove();
      end.remove();
    };
    try {
      insert(target, view(), end);
      return stop;
    } catch (error) {
      stop();
      throw error;
    }
  });
}

// Imperative artwork consumers need inert DOM, not a second live Solid root.
export function renderSolidSnapshot(view: () => JSX.Element): DocumentFragment {
  return withSolidRoot(null, (dispose) => {
    const host = document.createElement("div");
    try {
      insert(host, view());
      const snapshot = document.createDocumentFragment();
      for (const child of host.childNodes) {
        snapshot.append(child.cloneNode(true));
      }
      return snapshot;
    } finally {
      dispose();
    }
  });
}
