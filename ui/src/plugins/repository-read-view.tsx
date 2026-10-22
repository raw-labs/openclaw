import type { JSX } from "@solidjs/web";
import { onSettled } from "solid-js";
import type { RepositoryReadServices } from "../../../extensions/github-repositories/browser/read-presentation-api.ts";
import type { ControlUiComponentHandle } from "../../../src/plugin-sdk/control-ui.js";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import { createControlUiNativeHost } from "./control-ui-native-host.tsx";
import { createControlUiPresentationHost } from "./control-ui-presentation-host.tsx";
import { observeSolidBridgeProperties } from "./control-ui-properties.ts";

type ReadSnapshot = {
  mount(container: HTMLElement): () => void;
  update(): void;
};

const RepositoryRead = defineSolidBridge<{ snapshot: ReadSnapshot | undefined }>(
  "oc-repository-read",
  (_props, host) => {
    host.style.display = "contents";
    // Native property commits deliver plain values into the separately owned renderer.
    // The bridge owns settlement and teardown; no reactive owner crosses the boundary.
    observeSolidBridgeProperties(host, ["snapshot"], undefined, () => host.snapshot?.update());
    onSettled(() => host.snapshot?.mount(host));
    return undefined;
  },
  { properties: { snapshot: { default: undefined, attribute: false } } },
);

/**
 * TODO: Remove this native composition adapter when publication and the final
 * session-menu reader transfer the original connection read owner together.
 * This prefix moves renderers only; there is still exactly one native read store.
 */
export function repositoryReadView<P extends object>(
  mount: (
    container: HTMLElement,
    props: P,
    services: RepositoryReadServices,
  ) => ControlUiComponentHandle<P>,
  read: () => P,
  ci?: RepositoryReadServices["ci"],
): JSX.Element {
  let handle: ControlUiComponentHandle<P> | undefined;
  const snapshot = (value: P): ReadSnapshot => ({
    mount(container) {
      const abort = new AbortController();
      handle = mount(container, value, {
        native: createControlUiNativeHost(abort.signal),
        presentation: createControlUiPresentationHost(
          () => abort.signal.throwIfAborted(),
          abort.signal,
        ),
        ci,
      });
      return () => {
        abort.abort();
        handle?.dispose();
        handle = undefined;
      };
    },
    update() {
      handle?.update(value);
    },
  });
  return <RepositoryRead snapshot={snapshot(read())} />;
}
