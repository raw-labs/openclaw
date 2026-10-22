import type { ControlUiNativeHost } from "openclaw/plugin-sdk/control-ui";
import { createContext } from "solid-js";
export const NativeContext = createContext<ControlUiNativeHost>();
export const ContentPresentation = createContext<() => boolean>(() => true);
