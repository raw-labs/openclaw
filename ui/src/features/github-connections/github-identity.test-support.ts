import { createRoot } from "solid-js";
import {
  createGitHubIdentity,
  type GitHubIdentity,
  settingsEnglish as english,
} from "../../../../extensions/github-repositories/browser/index.tsx";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { resolveAgentConfig } from "../../lib/agents/display.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { registerControlUiEnglish } from "../../plugins/control-ui-english.ts";
import { trackSolidRoot } from "../../test-helpers/solid-cleanup.ts";
registerControlUiEnglish(english);

export function createGitHubIdentityForTest(
  deps: Partial<Parameters<typeof createGitHubIdentity>[0]> = {},
) {
  return createRoot((dispose) => {
    const identity = createGitHubIdentity({
      translate: t,
      confirm: showConfirmDialog,
      formatError: formatUiError,
      ...deps,
    });
    type Sync = Parameters<typeof identity.sync>[0];
    type Target = NonNullable<Sync["target"]>;
    type Shared = Extract<Target, { kind: "shared" }>;
    return {
      ...identity,
      sync(
        params: Omit<Sync, "target"> & {
          target:
            | Extract<Target, { kind: "personal" }>
            | (Omit<Shared, "config"> & { config: Record<string, unknown> | null })
            | null;
        },
      ) {
        const target = params.target;
        const config = target?.kind === "shared" ? target.config : null;
        const resolved =
          target?.kind === "shared" ? resolveAgentConfig(config, target.agentId) : null;
        identity.sync({
          ...params,
          target:
            target?.kind === "shared"
              ? {
                  ...target,
                  config: target.config
                    ? {
                        system: resolved?.globalTools?.github,
                        agent: resolved?.entry?.tools?.github,
                      }
                    : null,
                }
              : target,
        });
      },
      dispose: trackSolidRoot(dispose),
    };
  });
}
export type TestGitHubIdentity = ReturnType<typeof createGitHubIdentityForTest>;
type IdentityState = ReturnType<GitHubIdentity["read"]>;

export function githubIdentityViewFixture(overrides: Partial<IdentityState> = {}): GitHubIdentity {
  const state: IdentityState = {
    status: null,
    personal: null,
    system: null,
    loading: false,
    busy: false,
    error: null,
    statusReadable: true,
    configurable: false,
    authorizable: false,
    scope: "agent",
    connectionReady: false,
    draft: { token: "", name: "", email: "" },
    authorization: { phase: "idle" },
    authorizationActive: false,
    tokenRevealed: false,
    patVisible: false,
    ...overrides,
  };
  return {
    read: () => state,
    sync() {},
    ensureVerified() {},
    setDraft() {},
    showPatFallback() {},
    hidePatFallback() {},
    toggleTokenVisibility() {},
    async verify() {},
    async startAuthorization() {},
    async cancelAuthorization() {},
    async configure() {},
    async inherit() {},
    async disconnect() {},
  };
}
