import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAgentIdStrict } from "openclaw/plugin-sdk/routing";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { GITHUB_CONFIG_PATH, GITHUB_PLUGIN_ID } from "./config-api.js";

const record = (value: unknown) => asOptionalRecord(value);
const has = (value: unknown, key: string) => record(value)?.[key] !== undefined;
const legacyHostSettings = (value: unknown) => {
  const settings = record(value);
  const host = settings?.host;
  return typeof host === "string" && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(host.trim())
    ? { ...settings, host: host.trim().toLowerCase() }
    : settings;
};
const legacyAgentIdentity = (value: unknown) => {
  const agents = record(value);
  return (
    Object.values(record(agents?.entries) ?? {}).some((entry) =>
      has(record(entry)?.tools, "github"),
    ) ||
    (Array.isArray(agents?.list) &&
      agents.list.some((entry) => has(record(entry)?.tools, "github")))
  );
};
export const legacyConfigRules = [
  ...[
    ["tools", "github"],
    ["gateway", "github"],
    ["gateway", "controlUi", "github"],
    ["gateway", "projects", "nativeGitHubSearch"],
  ].map((path) => ({
    path,
    message: `${path.join(".")} moved to ${GITHUB_CONFIG_PATH}; run "openclaw doctor --fix".`,
  })),
  {
    path: ["agents"],
    match: legacyAgentIdentity,
    message: `Agent GitHub identities moved to ${GITHUB_CONFIG_PATH}.agents; run "openclaw doctor --fix".`,
  },
];

/** Doctor supplies a private candidate; its normal writer owns backup, includes and publication. */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
  warnings?: string[];
} {
  const raw = cfg as Record<string, unknown>;
  const oldTools = record(raw.tools);
  const oldGateway = record(raw.gateway);
  const oldUi = record(oldGateway?.controlUi);
  const oldProjects = record(oldGateway?.projects);
  const oldEntries = record(record(raw.plugins)?.entries);
  const oldEndpoint = legacyHostSettings(oldGateway?.github);
  const oldService = legacyHostSettings(oldUi?.github);
  if (
    !has(oldTools, "github") &&
    !oldEndpoint &&
    !oldService &&
    !has(oldProjects, "nativeGitHubSearch") &&
    !legacyAgentIdentity(raw.agents)
  ) {
    return { config: cfg, changes: [] };
  }
  const currentEntry = record(oldEntries?.[GITHUB_PLUGIN_ID]);
  const currentConfig = record(currentEntry?.config);
  let malformedPath: string | undefined;
  if (oldEntries?.[GITHUB_PLUGIN_ID] !== undefined && !currentEntry) {
    malformedPath = `plugins.entries.${GITHUB_PLUGIN_ID}`;
  } else if (currentEntry?.config !== undefined && !currentConfig) {
    malformedPath = GITHUB_CONFIG_PATH;
  } else {
    const targetedContainers = [
      { key: "service", touched: Boolean(oldService) },
      { key: "agents", touched: legacyAgentIdentity(raw.agents) },
      { key: "repositorySearch", touched: has(oldProjects, "nativeGitHubSearch") },
    ];
    const malformed = targetedContainers.find(
      ({ key, touched }) =>
        touched && currentConfig?.[key] !== undefined && !record(currentConfig[key]),
    );
    if (malformed) {
      malformedPath = `${GITHUB_CONFIG_PATH}.${malformed.key}`;
    }
  }
  if (malformedPath) {
    return {
      config: cfg,
      changes: [],
      warnings: [
        `${malformedPath} is invalid. All original settings were preserved; repair it before migrating legacy GitHub settings.`,
      ],
    };
  }
  const next: Record<string, unknown> = { ...raw };
  const changes: string[] = [];
  const warnings: string[] = [];
  const cloneRecord = (parent: Record<string, unknown>, key: string) => {
    const value = { ...record(parent[key]) };
    parent[key] = value;
    return value;
  };
  const plugins = cloneRecord(next, "plugins");
  const entries = cloneRecord(plugins, "entries");
  const entry = cloneRecord(entries, GITHUB_PLUGIN_ID);
  const config = cloneRecord(entry, "config");
  const move = (
    source: unknown,
    target: Record<string, unknown>,
    key: string,
    from: string,
    to: string,
  ) => {
    if (source === undefined) {
      return;
    }
    if (target[key] === undefined) {
      target[key] = source;
      changes.push(`Moved ${from} to ${to}.`);
    } else {
      changes.push(`Removed legacy ${from}; canonical ${to} remains authoritative.`);
      if (!isDeepStrictEqual(target[key], source)) {
        warnings.push(
          `Kept configured ${to} instead of conflicting ${from}. No credential values were logged.`,
        );
      }
    }
  };
  move(oldTools?.github, config, "system", "tools.github", `${GITHUB_CONFIG_PATH}.system`);
  if (has(oldTools, "github")) {
    const tools = cloneRecord(next, "tools");
    delete tools.github;
  }
  const endpointFields = ["host", "apiBaseUrl"] as const;
  const endpointSelection = (value: Record<string, unknown> | undefined) =>
    Object.fromEntries(
      endpointFields.flatMap((key) => (value?.[key] === undefined ? [] : [[key, value[key]]])),
    );
  const canonicalEndpoint = endpointSelection(config);
  const legacyEndpoint = endpointSelection(oldEndpoint);
  if (Object.keys(legacyEndpoint).length > 0 && Object.keys(canonicalEndpoint).length > 0) {
    changes.push(
      "Removed the legacy gateway.github endpoint selection; the canonical GitHub endpoint remains authoritative.",
    );
    if (!isDeepStrictEqual(canonicalEndpoint, legacyEndpoint)) {
      warnings.push(
        `Kept configured ${GITHUB_CONFIG_PATH}.host/apiBaseUrl as one endpoint selection instead of combining it with gateway.github. Review conflicting legacy endpoint settings; no values were logged.`,
      );
    }
  } else {
    for (const key of endpointFields) {
      move(
        oldEndpoint?.[key],
        config,
        key,
        `gateway.github.${key}`,
        `${GITHUB_CONFIG_PATH}.${key}`,
      );
    }
  }
  if (oldEndpoint || oldService || has(oldProjects, "nativeGitHubSearch")) {
    const gateway = cloneRecord(next, "gateway");
    if (oldEndpoint) {
      const remaining = { ...oldEndpoint };
      delete remaining.host;
      delete remaining.apiBaseUrl;
      if (Object.keys(remaining).length === 0) {
        delete gateway.github;
        if (Object.keys(oldEndpoint).length === 0) {
          changes.push("Removed empty legacy gateway.github.");
        }
      } else {
        gateway.github = remaining;
        warnings.push(
          "Unrecognized legacy gateway.github fields were preserved; review them before starting the Gateway.",
        );
      }
    }
    if (oldService) {
      const service = cloneRecord(config, "service");
      const serviceFields = ["host", "token"] as const;
      const serviceSelection = (value: Record<string, unknown>) =>
        Object.fromEntries(
          serviceFields.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])),
        );
      const canonicalService = serviceSelection(service);
      const legacyService = serviceSelection(oldService);
      if (Object.keys(legacyService).length > 0 && Object.keys(canonicalService).length > 0) {
        changes.push(
          "Removed the legacy gateway.controlUi.github credential selection; the canonical GitHub service selection remains authoritative.",
        );
        if (!isDeepStrictEqual(canonicalService, legacyService)) {
          warnings.push(
            `Kept configured ${GITHUB_CONFIG_PATH}.service as one credential/host selection instead of combining it with gateway.controlUi.github. Review conflicting legacy service settings; no credential values were logged.`,
          );
        }
      } else {
        for (const key of serviceFields) {
          move(
            oldService[key],
            service,
            key,
            `gateway.controlUi.github.${key}`,
            `${GITHUB_CONFIG_PATH}.service.${key}`,
          );
        }
      }
      const ui = cloneRecord(gateway, "controlUi");
      const remaining = { ...oldService };
      delete remaining.host;
      delete remaining.token;
      if (Object.keys(remaining).length === 0) {
        delete ui.github;
        if (Object.keys(oldService).length === 0) {
          changes.push("Removed empty legacy gateway.controlUi.github.");
        }
      } else {
        ui.github = remaining;
        warnings.push(
          "Unrecognized legacy gateway.controlUi.github fields were preserved; review them before starting the Gateway.",
        );
      }
    }
    if (has(oldProjects, "nativeGitHubSearch")) {
      const search = cloneRecord(config, "repositorySearch");
      move(
        oldProjects?.nativeGitHubSearch,
        search,
        "useNativeCredentials",
        "gateway.projects.nativeGitHubSearch",
        `${GITHUB_CONFIG_PATH}.repositorySearch.useNativeCredentials`,
      );
      const projects = cloneRecord(gateway, "projects");
      delete projects.nativeGitHubSearch;
    }
  }
  if (legacyAgentIdentity(raw.agents)) {
    const agents = cloneRecord(next, "agents");
    const identities = cloneRecord(config, "agents");
    const migratedAgentIds = new Set<string>();
    const migrateAgent = (value: unknown, id: string, path: string) => {
      const source = record(value);
      if (!has(source?.tools, "github")) {
        return value;
      }
      const normalized = normalizeAgentIdStrict(id);
      if (!normalized.ok || migratedAgentIds.has(normalized.value)) {
        throw new Error(
          "Legacy GitHub agent identities are invalid or collide after normalization; repair the agent roster before migration.",
        );
      }
      migratedAgentIds.add(normalized.value);
      move(
        record(source?.tools)?.github,
        identities,
        normalized.value,
        `${path}.tools.github`,
        `${GITHUB_CONFIG_PATH}.agents.${normalized.value}`,
      );
      const updated = { ...source };
      const tools = cloneRecord(updated, "tools");
      delete tools.github;
      return updated;
    };
    if (record(agents.entries)) {
      const agentEntries = cloneRecord(agents, "entries");
      for (const [id, value] of Object.entries(agentEntries)) {
        agentEntries[id] = migrateAgent(value, id, `agents.entries.${id}`);
      }
    }
    if (Array.isArray(agents.list)) {
      agents.list = agents.list.map((value, index) => {
        const id = record(value)?.id;
        return typeof id === "string" ? migrateAgent(value, id, `agents.list[${index}]`) : value;
      });
    }
  }
  if (
    Array.isArray(plugins.allow) &&
    plugins.allow.length > 0 &&
    !plugins.allow.includes(GITHUB_PLUGIN_ID)
  ) {
    warnings.push(
      `This migration did not widen the allowlist. Doctor's existing configured-plugin repair may enable and allowlist ${GITHUB_PLUGIN_ID}; an explicit plugin disable, deny entry, or global disable still prevents activation.`,
    );
  }
  return { config: next as OpenClawConfig, changes, ...(warnings.length ? { warnings } : {}) };
}
