import type { ControlUiSessionPullRequest } from "@openclaw/gateway-protocol";
import { createMemo, onSettled, useContext } from "solid-js";
import { RepositoryCiContext } from "./ci-context.ts";

export type ChatCiDisclosureProps = {
  pullRequest?: ControlUiSessionPullRequest;
  sessionKey: string;
  presented: boolean;
  /** An enclosing page owns visibility instead of a details disclosure. */
  inline?: boolean;
};

/** The disclosure owns visibility; the two CI projections own their request fences. */
export function createCiDisclosure(
  host: () => HTMLElement,
  read: () => Pick<ChatCiDisclosureProps, "presented" | "inline">,
  onVisibility: () => void,
  connect: () => () => void,
) {
  const listen = (target: EventTarget, name: string, listener: EventListener) => {
    target.addEventListener(name, listener);
    return () => target.removeEventListener(name, listener);
  };
  const services = useContext(RepositoryCiContext);
  // Prepare compiled prop getters before lifecycle callbacks forbid new computations.
  const presentation = createMemo(() => ({
    presented: read().presented,
    inline: read().inline,
  }));
  let disclosure: HTMLDetailsElement | null = null;
  let active = false;
  const isConnected = () => active && host().isConnected;
  const visible = () =>
    isConnected() &&
    presentation().presented &&
    services.isPresented() &&
    (presentation().inline || disclosure?.open === true) &&
    host().ownerDocument.visibilityState !== "hidden";
  onSettled(() => {
    active = true;
    disclosure = host().closest<HTMLDetailsElement>(".chat-pr__checks");
    const document = host().ownerDocument;
    const toggle = (event: Event) => {
      if (event.target === disclosure) {
        onVisibility();
      }
    };
    const stopToggle = disclosure && listen(disclosure, "toggle", toggle);
    const stopVisibility = listen(document, "visibilitychange", onVisibility);
    const disconnect = connect();
    onVisibility();
    return () => {
      active = false;
      stopToggle?.();
      stopVisibility();
      disconnect();
    };
  });
  return {
    isConnected,
    visible,
    close: () => {
      if (disclosure) {
        disclosure.open = false;
      }
    },
  };
}
