/** @jsxImportSource @solidjs/web */

import type { JSX } from "@solidjs/web";
import type { ControlUiComponentHandle } from "openclaw/plugin-sdk/control-ui";
import { createMemo, createEffect, onCleanup, untrack, getOwner } from "solid-js";
import { mountPluginContent } from "./render-owned.ts";
export function content(read: () => JSX.Element, owner = getOwner()): HTMLElement {
  const node = document.createElement("span");
  node.style.display = "contents";
  const stop = mountPluginContent(() => read, node, owner);
  onCleanup(stop);
  return node;
}
export function hostControl<P extends object>(
  read: () => P,
  mount: (container: HTMLElement, props: P) => ControlUiComponentHandle<P>,
) {
  const node = document.createElement("span");
  node.style.display = "contents";
  const value = createMemo(read);
  const handle = mount(node, untrack(value));
  createEffect(value, (next) => handle.update(next));
  onCleanup(() => handle.dispose());
  return node;
}
