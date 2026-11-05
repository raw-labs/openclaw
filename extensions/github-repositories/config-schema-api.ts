import { MANAGED_GITHUB_PROFILE_ID_PATTERN } from "openclaw/plugin-sdk/native-github-account-host";
import { normalizeAgentIdStrict } from "openclaw/plugin-sdk/routing";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const secret = buildSecretInputSchema();
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hostname = z
  .string()
  .trim()
  .regex(/^\s*[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\s*$/u)
  .refine((value) => !value.includes(".."), "GitHub host must be a hostname");
const identityFields = {
  profileId: z.string().regex(MANAGED_GITHUB_PROFILE_ID_PATTERN),
  gitAuthor: z
    .strictObject({
      name: z.string().trim().min(1).optional(),
      email: z.string().trim().min(1).optional(),
    })
    .optional(),
};
const app = z.strictObject({
  appId: id,
  installationId: id,
  accountId: id,
  repositories: z
    .array(
      z.strictObject({
        id,
        fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
      }),
    )
    .min(1)
    .max(100)
    .refine((values) => new Set(values.map((value) => value.id)).size === values.length),
  permissions: z.record(z.string().regex(/^[a-z_]+$/u), z.enum(["read", "write"])),
  privateKey: secret,
  keyVersion: z.string().trim().min(1).max(256),
});
const identity = z.discriminatedUnion("kind", [
  z.strictObject({ ...identityFields, kind: z.literal("oauth").optional() }),
  z.strictObject({ ...identityFields, kind: z.literal("app-installation"), app }),
]);
const agentIdentity = z.discriminatedUnion("kind", [
  identity.options[0].extend({ allowInSandbox: z.boolean().optional() }),
  identity.options[1].extend({ allowInSandbox: z.boolean().optional() }),
]);
const agentId = z.string().refine((value) => {
  const normalized = normalizeAgentIdStrict(value);
  return normalized.ok && normalized.value === value;
}, "Use a canonical normalized agent id");

/** Canonical plugin config; runtime registration validates the endpoint pair before contributions. */
export const GitHubPluginConfigSchema = z
  .strictObject({
    host: hostname.optional(),
    apiBaseUrl: z.string().url().optional(),
    service: z.strictObject({ host: hostname.optional(), token: secret.optional() }).optional(),
    system: identity.optional(),
    agents: z.record(agentId, agentIdentity).optional(),
    repositorySearch: z.strictObject({ useNativeCredentials: z.boolean().optional() }).optional(),
  })
  .superRefine((config, context) => {
    if (!config.host && !config.apiBaseUrl) {
      return;
    }
    const host = config.host?.toLowerCase();
    if (!host || !config.apiBaseUrl) {
      context.addIssue({
        code: "custom",
        path: [!host ? "host" : "apiBaseUrl"],
        message: "Configure GitHub host and API base URL together",
      });
      return;
    }
    let api: URL;
    try {
      api = new URL(config.apiBaseUrl);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["apiBaseUrl"],
        message: "GitHub API base URL must be a valid HTTPS URL",
      });
      return;
    }
    const cloudApi = api.hostname === `api.${host}` && api.pathname === "/";
    const serverApi = api.hostname === host && ["/api/v3", "/api/v3/"].includes(api.pathname);
    if (
      api.protocol !== "https:" ||
      api.username ||
      api.password ||
      api.search ||
      api.hash ||
      (!cloudApi && !serverApi)
    ) {
      context.addIssue({
        code: "custom",
        path: ["apiBaseUrl"],
        message: "GitHub API base URL must match the configured HTTPS host",
      });
    }
  });
