/** @jsxImportSource @solidjs/web */

import { Show, useContext } from "solid-js";
import { hostControl } from "./host-control.tsx";
import { NativeContext } from "./native-context.tsx";
export function SessionGitDiff(props: {
  item: { additions?: number; deletions?: number };
  classPrefix: "chat-pr" | "session-hovercard" | "activity-feed";
  onOpen?: () => void;
}) {
  const native = useContext(NativeContext);
  return hostControl(
    () => ({ item: props.item, classPrefix: props.classPrefix, onOpen: props.onOpen }),
    native.mountDiff,
  );
}

export function GitDiffValues(props: {
  item: { additions?: number; deletions?: number };
  classPrefix: "session-hovercard" | "chat-pr" | "activity-feed";
  locale?: string;
  spaced?: boolean;
}) {
  return (
    <>
      <Show when={props.item.additions !== undefined}>
        <span class={props.classPrefix + "__additions"}>
          +{props.item.additions?.toLocaleString(props.locale)}
        </span>
      </Show>
      {props.spaced ? " " : null}
      <Show when={props.item.deletions !== undefined}>
        <span class={props.classPrefix + "__deletions"}>
          −{props.item.deletions?.toLocaleString(props.locale)}
        </span>
      </Show>
    </>
  );
}
