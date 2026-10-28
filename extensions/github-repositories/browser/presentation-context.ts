import type { ControlUiPresentationHost } from "openclaw/plugin-sdk/control-ui";
import { createContext, useContext } from "solid-js";
export const PresentationContext = createContext<ControlUiPresentationHost>();
export function presentationTranslator() {
  const host = useContext(PresentationContext);
  return (key: string, params?: Record<string, string>) => host.translate(key, params);
}
