/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import type {
  ControlUiComponentHandle,
  ControlUiNativeHost,
  ControlUiPresentationHost,
} from "openclaw/plugin-sdk/control-ui";
import { createComponent, createSignal, merge, onCleanup } from "solid-js";
import { NativeContext } from "./native-context.tsx";
import { PresentationContext } from "./presentation-context.ts";
import { CiReadContext, type CiReadServices } from "./read-ci.tsx";
import { mountPluginContent } from "./render-owned.ts";

export type RepositoryReadServices = {
  native: ControlUiNativeHost;
  presentation: ControlUiPresentationHost;
  ci?: CiReadServices;
};

/** One independent renderer; no native or plugin reactive owner crosses this boundary. */
export function readView<P extends object>(
  view: (props: ReturnType<typeof merge<[() => P]>>) => JSX.Element,
) {
  return (
    container: HTMLElement,
    initial: P,
    services: RepositoryReadServices,
  ): ControlUiComponentHandle<P> => {
    const [state, setState] = createSignal({ value: initial }, { ownedWrite: true });
    let disposed = false;
    const stop = mountPluginContent(
      () => {
        const [revision, setRevision] = createSignal(0, { ownedWrite: true });
        const stopLocale = services.presentation.subscribe(() => setRevision((value) => value + 1));
        onCleanup(stopLocale);
        const presentation = {
          ...services.presentation,
          translate(key: string, params?: Record<string, string>) {
            revision();
            return services.presentation.translate(key, params);
          },
        };
        return (
          <PresentationContext value={presentation}>
            <NativeContext value={services.native}>
              <CiReadContext value={services.ci}>
                {createComponent(
                  view,
                  merge(() => state().value),
                )}
              </CiReadContext>
            </NativeContext>
          </PresentationContext>
        );
      },
      container,
      null,
    );
    return {
      update(value) {
        if (disposed) {
          throw new Error("This repository read view has ended.");
        }
        setState({ value });
      },
      dispose() {
        if (!disposed) {
          disposed = true;
          stop();
        }
      },
    };
  };
}
