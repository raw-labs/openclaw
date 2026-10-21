import { insert, registerDelegatedRoot, unregisterDelegatedRoot, type JSX } from "@solidjs/web";
import { createRoot, runWithOwner, type getOwner } from "solid-js";

/** The self-contained plugin renderer owns its islands and never flushes a host commit. */
export function mountPluginContent(
  view: () => JSX.Element | (() => JSX.Element),
  target: HTMLElement,
  owner: ReturnType<typeof getOwner> = null,
) {
  return runWithOwner(owner, () =>
    createRoot((dispose) => {
      const start = document.createComment("repository-content-start"),
        end = document.createComment("repository-content-end");
      target.append(start, end);
      registerDelegatedRoot(target);
      let live = true;
      const stop = () => {
        if (!live) {
          return;
        }
        live = false;
        unregisterDelegatedRoot(target);
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
    }),
  );
}
