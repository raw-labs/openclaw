import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { en } from "../i18n/locales/en.ts";
import { registerEnglishCatalog } from "../lib/reactive/i18n.ts";
type ControlUiTranslationMap = { readonly [key: string]: string | ControlUiTranslationMap };

const englishRegistrations = new WeakMap<ControlUiTranslationMap, () => void>();
export function registerControlUiEnglish(catalog: ControlUiTranslationMap) {
  let register = englishRegistrations.get(catalog);
  if (!register) {
    register = () => {
      const merge = (target: Record<string, unknown>, source: ControlUiTranslationMap) => {
        for (const [key, value] of Object.entries(source)) {
          if (typeof value === "string") {
            target[key] = value;
          } else {
            const previous = target[key];
            const child = isRecord(previous) ? previous : {};
            target[key] = child;
            merge(child, value);
          }
        }
      };
      merge(en, catalog);
    };
    englishRegistrations.set(catalog, register);
  }
  registerEnglishCatalog(register);
}
