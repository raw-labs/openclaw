import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { GITHUB_PLUGIN_ID } from "./host-api.js";

function hasRetiredReaderPolicy(value: unknown): boolean {
  const plugins = asOptionalRecord(value);
  const entry = asOptionalRecord(asOptionalRecord(plugins?.entries)?.[GITHUB_PLUGIN_ID]);
  const reader = asOptionalRecord(asOptionalRecord(entry?.config)?.reader);
  return (
    reader?.enabled === undefined &&
    ((Array.isArray(plugins?.allow) && plugins.allow.length > 0) ||
      (Array.isArray(plugins?.deny) && plugins.deny.includes("github")))
  );
}

export const legacyConfigRules = [
  {
    path: ["plugins", "entries", "github"],
    message:
      'The retired github reader policy moved to plugins.entries.github-repositories.config.reader; run "openclaw doctor --fix".',
  },
  {
    path: ["plugins"],
    match: hasRetiredReaderPolicy,
    message:
      'The retired github reader admission policy moved to plugins.entries.github-repositories.config.reader; run "openclaw doctor --fix".',
  },
];

/** Only reader policy moves here; native identity and service configuration keep their current owner. */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
  warnings?: string[];
} {
  const plugins = cfg.plugins;
  const old = plugins?.entries?.github;
  const reader = asOptionalRecord(old);
  const oldConfig = asOptionalRecord(reader?.config);
  if (
    old !== undefined &&
    (!reader ||
      Object.keys(reader).some((key) => key !== "enabled" && key !== "config") ||
      (reader.enabled !== undefined && typeof reader.enabled !== "boolean") ||
      (reader.config !== undefined && (!oldConfig || Object.keys(oldConfig).length > 0)))
  ) {
    return {
      config: cfg,
      changes: [],
      warnings: [
        "The retired github reader entry contains additional or invalid plugin policy or configuration. Review its migration to github-repositories explicitly; all original settings were preserved.",
      ],
    };
  }
  if (!reader && !hasRetiredReaderPolicy(plugins)) {
    return { config: cfg, changes: [] };
  }
  const entry = plugins?.entries?.[GITHUB_PLUGIN_ID];
  const config = asOptionalRecord(entry?.config);
  const currentReader = asOptionalRecord(config?.reader);
  if (
    (entry?.config !== undefined && !config) ||
    (config?.reader !== undefined && !currentReader) ||
    (currentReader?.enabled !== undefined && typeof currentReader.enabled !== "boolean")
  ) {
    return {
      config: cfg,
      changes: [],
      warnings: [
        "The configured GitHub reader policy is invalid. All original settings were preserved; repair it before migrating the retired reader entry.",
      ],
    };
  }
  const denied = plugins?.deny?.includes("github") === true;
  const excluded = Boolean(plugins?.allow?.length && !plugins.allow.includes("github"));
  const enabled = reader?.enabled !== false && !denied && !excluded;
  const entries: NonNullable<NonNullable<OpenClawConfig["plugins"]>["entries"]> = {
    ...plugins?.entries,
    [GITHUB_PLUGIN_ID]: {
      ...entry,
      config: {
        ...config,
        reader: { ...currentReader, enabled: currentReader?.enabled ?? enabled },
      },
    },
  };
  delete entries.github;
  const warnings: string[] = [];
  if (plugins?.allow?.length && !plugins.allow.includes(GITHUB_PLUGIN_ID)) {
    warnings.push(
      "The reader migration did not widen the allowlist. Doctor's existing configured-plugin repair may enable and allowlist github-repositories; an explicit new plugin disable, deny entry, or global disable still prevents activation.",
    );
  }
  return {
    config: { ...cfg, plugins: { ...plugins, entries } },
    changes: [
      "Moved the retired github reader policy to plugins.entries.github-repositories.config.reader; native GitHub account and publication settings remain unchanged.",
    ],
    ...(warnings.length ? { warnings } : {}),
  };
}
