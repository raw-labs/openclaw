import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";
import { GitHubPluginConfigSchema } from "./config-schema-api.js";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const profileId = "ghp_0123456789abcdef0123456789abcdef";
const secret = { source: "store", provider: "default", id: "GITHUB_SERVICE" };

describe("GitHub plugin configuration admission", () => {
  it("admits a service SecretRef and an agent-only sandbox identity permission", () => {
    const config = {
      system: { profileId },
      agents: { release: { profileId, allowInSandbox: true } },
      service: { token: secret },
    };
    expect(GitHubPluginConfigSchema.parse(config)).toEqual(config);
  });

  it.each([
    { system: { profileId, token: secret } },
    { system: { profileId: "../../native" } },
    { system: {} },
    { system: { profileId, allowInSandbox: true } },
    { agents: { release: { profileId, allowInSandbox: "true" } } },
    { agents: { Build: { profileId } } },
    { agents: { " build ": { profileId } } },
    { agents: { Build: { profileId }, build: { profileId } } },
  ])("rejects malformed identities and misplaced sandbox permissions: %j", (input) => {
    expect(GitHubPluginConfigSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    { host: "tenant.ghe.com", apiBaseUrl: "https://api.tenant.ghe.com" },
    { host: "tenant.ghe.com", apiBaseUrl: "https://tenant.ghe.com/api/v3" },
    { host: "GHE.EXAMPLE.TEST", apiBaseUrl: "https://ghe.example.test/api/v3" },
    { host: " ghe.example.test ", apiBaseUrl: "https://ghe.example.test/api/v3" },
  ])("admits a matching HTTPS GitHub endpoint: %j", (input) => {
    expect(GitHubPluginConfigSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    { host: "ghe.example.test", apiBaseUrl: "https://api.other.example.test" },
    { host: "ghe.example.test", apiBaseUrl: "http://ghe.example.test/api/v3" },
    { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/other" },
    { host: "ghe.example.test" },
    { host: "ghe.example.test", apiBaseUrl: "not-a-url" },
    { host: "ghe..example.test", apiBaseUrl: "https://ghe..example.test/api/v3" },
    { host: "ghe example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
  ])("rejects invalid canonical endpoints before registering native contributions: %j", (input) => {
    expect(GitHubPluginConfigSchema.safeParse(input).success).toBe(false);
    const fixture = createPluginRegistryFixture({
      plugins: { entries: { "github-repositories": { config: input } } },
    });
    expect(() =>
      registerVirtualTestPlugin({
        ...fixture,
        id: manifest.id,
        name: manifest.name,
        contracts: manifest.contracts,
        register: plugin.register,
      }),
    ).toThrow(/host|API|URL|hostname|pattern/i);
    expect(fixture.registry.registry.controlUiDescriptors).toEqual([]);
    expect(fixture.registry.registry.services).toEqual([]);
    expect(fixture.registry.registry.gatewayMethodDescriptors).toEqual([]);
  });
});
