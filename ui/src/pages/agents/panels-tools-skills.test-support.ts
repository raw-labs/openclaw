import { createComponent } from "solid-js";
import { vi } from "vitest";
import type { TestGitHubIdentity } from "../../features/github-connections/github-identity.test-support.ts";
import { githubIdentityViewFixture } from "../../features/github-connections/github-identity.test-support.ts";
import { GitHubIdentity } from "../../features/github-connections/github-settings.test-support.tsx";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import type { AgentTools } from "./panels-tools-skills.tsx";

type Params = Parameters<typeof AgentTools>[0] & {
  githubIdentity: Omit<TestGitHubIdentity, "dispose">;
  onOpenGitHubConnections: () => void;
} & Pick<
    ReturnType<Parameters<typeof AgentTools>[0]["readData"]>,
    | "toolsCatalogLoading"
    | "toolsCatalogError"
    | "toolsCatalogResult"
    | "toolsEffectiveLoading"
    | "toolsEffectiveError"
    | "toolsEffectiveResult"
  >;

export function createBaseParams(overrides: Partial<Params> = {}): Params {
  const githubIdentity = githubIdentityViewFixture();
  const params: Params = {
    readData() {
      return { ...createAgentViewTestProps().readData(), ...this };
    },
    agentId: "main",
    canUpdateConfig: true,
    configForm: {
      agents: {
        entries: { main: { tools: { profile: "full" } } },
      },
    } as Record<string, unknown>,
    configLoading: false,
    configSaving: false,
    configDirty: false,
    toolsCatalogLoading: false,
    toolsCatalogError: null,
    toolsCatalogResult: null,
    toolsEffectiveLoading: false,
    toolsEffectiveError: null,
    toolsEffectiveResult: null,
    runtimeSessionKey: "main",
    runtimeSessionMatchesSelectedAgent: true,
    githubIdentity,
    renderSettings: () =>
      createComponent(GitHubIdentity, {
        get identity() {
          return params.githubIdentity;
        },
        onOpenConnections: () => params.onOpenGitHubConnections(),
      }),
    onOpenGitHubConnections: vi.fn(),
    onProfileChange: () => undefined,
    onOverridesChange: () => undefined,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    ...overrides,
  };
  return params;
}
