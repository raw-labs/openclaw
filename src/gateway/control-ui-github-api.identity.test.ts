import { afterEach, expect, it, vi } from "vitest";
import { readGitHubConfig } from "../../extensions/github-repositories/config-api.js";
import type { GitHubPluginConfig } from "../../extensions/github-repositories/config-api.js";
import {
  gitHubPublicApi,
  githubApiToken,
  hasConfiguredGitHubApiCredential,
} from "../../extensions/github-repositories/public-api.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  setActiveDegradedSecretOwners,
  SecretSurfaceUnavailableError,
} from "../secrets/runtime-degraded-state.js";

afterEach(() => {
  setActiveDegradedSecretOwners([]);
  clearRuntimeConfigSnapshot();
});

const coldToken = { source: "store", provider: "default", id: "PREVIEW_TOKEN" } as const;
const enterpriseHost = "ghe.example.test";
const ambient = { GH_TOKEN: "ambient-gh", GITHUB_TOKEN: "ambient-github" };
function previewConfig(service: GitHubPluginConfig["service"], host?: string): OpenClawConfig {
  return { plugins: { entries: { "github-repositories": { config: { host, service } } } } };
}

it.each([
  { enabled: false },
  { entries: { github: { enabled: false } } },
  { allow: ["another-plugin"] },
])("keeps host reads available with plugins %j", async (plugins) => {
  setRuntimeConfigSnapshot({ plugins });
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 1 }));
  expect(gitHubPublicApi.resolveGitHubApiCredentialScope({}).token).toBeUndefined();
  await expect(
    gitHubPublicApi.fetchGitHubJson("https://api.github.com/user", fetchMock),
  ).resolves.toEqual({ id: 1 });
  expect(fetchMock).toHaveBeenCalledOnce();
});

it.each([
  ["ambient fallback", {}, "ambient-gh"],
  ["no public token on Enterprise", previewConfig(undefined, enterpriseHost), undefined],
  [
    "separate preview credential",
    {
      ...previewConfig({ token: "preview-service-token" }),
      tools: {},
      plugins: {
        entries: {
          "github-repositories": {
            config: {
              ...readGitHubConfig(previewConfig({ token: "preview-service-token" })),
              service: { token: "preview-service-token" },
              system: { profileId: "ghp_99999999999999999999999999999999" },
            },
          },
        },
      },
    },
    "preview-service-token",
  ],
  [
    "host-bound Enterprise credential",
    previewConfig({ host: enterpriseHost, token: "enterprise-token" }, enterpriseHost),
    "enterprise-token",
  ],
] satisfies [string, OpenClawConfig, string | undefined][])("%s", (_name, config, expected) => {
  expect(githubApiToken(ambient, config)).toBe(expected);
});

it.each([
  ["unmaterialized SecretRef", previewConfig({ token: coldToken })],
  ["mismatched host", previewConfig({ token: "public-service-token" }, enterpriseHost)],
] satisfies [string, OpenClawConfig][])("fails closed for %s", (_name, config) => {
  expect(() => githubApiToken({ GH_TOKEN: "public-token" }, config)).toThrow(
    SecretSurfaceUnavailableError,
  );
});

it("fails closed for an explicitly configured cold SecretRef owner", () => {
  const config = previewConfig({ token: coldToken });
  setActiveDegradedSecretOwners([
    {
      ownerKind: "capability",
      ownerId: "plugins.entries.github-repositories.config.service.token",
      state: "unavailable",
      degradationState: "cold",
      paths: ["plugins.entries.github-repositories.config.service.token"],
      refKeys: ["store:default:PREVIEW_TOKEN"],
      reason: "secret reference was not found",
    },
  ]);

  expect(() => githubApiToken({ GH_TOKEN: "ambient" }, config)).toThrow(
    SecretSurfaceUnavailableError,
  );
  expect(hasConfiguredGitHubApiCredential({}, config)).toBe(true);
  expect(githubApiToken({ GH_TOKEN: "ambient" }, {})).toBe("ambient");
});
