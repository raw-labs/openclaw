import { Show } from "solid-js";
import type { MenuHandle } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { ChatDetailsDesktopBody } from "./chat-details-desktop-body.tsx";
import { ChatDetailsProgress } from "./chat-details-progress.tsx";
import { ChatDetailsSession } from "./chat-details-session.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";

export type ChatDetailsDesktopCompositionProps = {
  props?: ChatDetailsProps;
  presented: boolean;
  dismissed?: boolean;
} & {
  /** The native host keeps ownership of top-layer menus and Undo/focus behavior. */
  progressMenuRef?: (menu: MenuHandle) => void;
  onHideProgress?: () => void;
};

/** Desktop entry point: one scroll body and the native Progress owner after Outputs. */
export function ChatDetailsDesktopComposition(props: ChatDetailsDesktopCompositionProps) {
  return (
    <ChatDetailsDesktopBody presented={props.presented}>
      <ChatDetailsSession
        props={props.props}
        presented={props.presented}
        dismissed={props.dismissed}
        desktop
      />
      <Show when={props.props?.progressCard}>
        <ChatDetailsProgress
          desktop
          props={props.props}
          presented={props.presented}
          menuRef={props.progressMenuRef}
          onHideProgress={props.onHideProgress}
        />
      </Show>
      <Show when={!props.props?.progressCard && props.props?.progressCardError}>
        {(error) => (
          <div class="chat-details__muted" role="status">
            {t(
              error() === "access-denied"
                ? "sessionProgressCard.widgetAccessDenied"
                : "sessionProgressCard.widgetUnavailable",
            )}
          </div>
        )}
      </Show>
    </ChatDetailsDesktopBody>
  );
}
