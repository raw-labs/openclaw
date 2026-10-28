/** @jsxImportSource @solidjs/web */

import type { ControlUiNativeHost } from "openclaw/plugin-sdk/control-ui";
import { createContext, createSignal, onSettled } from "solid-js";
export const NativeContext = createContext<ControlUiNativeHost>();
export const ContentPresentation = createContext<() => boolean>(() => true);

export type PresentationValue =
  | boolean
  | { owner: EventTarget; isPresented: () => boolean; preview?: () => boolean };
export function projectPresentation(source: PresentationValue) {
  const [revision, setRevision] = createSignal(0);
  if (typeof source !== "boolean") {
    onSettled(() => {
      const changed = () => setRevision((value) => value + 1);
      source.owner.addEventListener("openclaw:presentation-changed", changed);
      return () => source.owner.removeEventListener("openclaw:presentation-changed", changed);
    });
  }
  return {
    read: () => {
      revision();
      return typeof source === "boolean" ? source : source.isPresented();
    },
  };
}
