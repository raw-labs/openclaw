import { createSignal } from "solid-js";
import type {
  CiReadProps,
  RepositoryReadServices,
} from "../../../extensions/github-repositories/browser/read-presentation-api.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { mountSolidContent } from "../lib/dom/solid-snapshot.ts";
import { ChatCiAutomation } from "../pages/chat/components/chat-ci-automation-control.tsx";
import { ChatCiDetails } from "../pages/chat/components/chat-ci-details.tsx";

/** The existing CI request/write owners stay lazy with their actual chat callers. */
export function repositoryReadCi(
  gateway: () => ApplicationGateway | undefined,
): NonNullable<RepositoryReadServices["ci"]> {
  const ci = (automation: boolean) => (container: HTMLElement, initial: CiReadProps) => {
    const [props, setProps] = createSignal({ value: initial }, { ownedWrite: true });
    const stop = mountSolidContent(container, () =>
      automation ? (
        <ChatCiAutomation
          {...props().value}
          sessionId={props().value.sessionId ?? ""}
          gateway={gateway()}
        />
      ) : (
        <ChatCiDetails {...props().value} gateway={gateway()} />
      ),
    );
    return {
      update(value: CiReadProps) {
        setProps({ value });
      },
      dispose: stop,
    };
  };
  return { mountDetails: ci(false), mountAutomation: ci(true) };
}
