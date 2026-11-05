import type { ControlUiSettingsContextV2 } from "openclaw/plugin-sdk/control-ui";
import { createContext, useContext } from "solid-js";
import { english } from "./settings-english.ts";

export const SettingsContext = createContext<ControlUiSettingsContextV2>();

export { english } from "./settings-english.ts";
function englishText(key: string): string | undefined {
  let value: unknown = english;
  for (const part of key.split(".")) {
    value = value && typeof value === "object" ? Reflect.get(value, part) : undefined;
  }
  return typeof value === "string" ? value : undefined;
}
export function translator(context: ControlUiSettingsContextV2) {
  return (key: string, params?: Record<string, string>) => {
    void context.props.locale;
    const translated = context.translate?.(key, params);
    const text = translated && translated !== key ? translated : (englishText(key) ?? key);
    return text.replace(/\{(\w+)\}/g, (match, name: string) => params?.[name] ?? match);
  };
}
export function useSettings() {
  return useContext(SettingsContext);
}
