import {
  loadAuthProfileStoreForRuntimeAsync,
  resolveApiKeyForProfile,
  type AuthProfileStore,
} from "../../auth-profiles.js";
import { hasOAuthIdentity, isSafeToCopyOAuthIdentity } from "../../auth-profiles/oauth-identity.js";
import type { OAuthCredential } from "../../auth-profiles/types.js";
import type { EmbeddedRequestApiKeyResolver } from "../stream-resolution.js";
import type { EmbeddedRunAuthState } from "./auth-controller.js";
import type { RunEmbeddedAgentParams } from "./params.js";

/** The run controller retains selection; the OAuth owner retains renewable material. */
export function createEmbeddedRequestApiKeyResolver(params: {
  state: EmbeddedRunAuthState;
  assertCurrent?: () => void;
  authStore: AuthProfileStore;
  agentDir: string;
  provider: string;
  config: RunEmbeddedAgentParams["config"];
}): EmbeddedRequestApiKeyResolver | undefined {
  const { state } = params;
  const selected = state.apiKeyInfo;
  const profileId = state.lastProfileId;
  if (
    state.runtimeAuthState ||
    !profileId ||
    selected?.mode !== "oauth" ||
    selected.authFlow !== "chatgpt-token-sharing" ||
    state.models.runtime.provider !== "openai" ||
    state.models.runtime.api !== "openai-responses"
  ) {
    return undefined;
  }
  const selectedCredential = params.authStore.profiles[profileId];
  if (selectedCredential?.type !== "oauth" || !hasOAuthIdentity(selectedCredential)) {
    throw new Error("Selected renewable profile has no verified account identity.");
  }
  const identity = {
    provider: selectedCredential.provider,
    authFlow: selectedCredential.authFlow,
    accountId: selectedCredential.accountId,
    email: selectedCredential.email,
    issuer: selectedCredential.issuer,
    clientId: selectedCredential.clientId,
  };
  const profileIndex = state.profileIndex;
  const assertSelected = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    params.assertCurrent?.();
    if (
      state.apiKeyInfo !== selected ||
      state.lastProfileId !== profileId ||
      state.profileIndex !== profileIndex ||
      state.runtimeAuthState
    ) {
      throw new Error("Selected request credential is no longer current.");
    }
  };
  const validate = (credential: OAuthCredential) => {
    if (
      credential.provider !== identity.provider ||
      credential.authFlow !== identity.authFlow ||
      !isSafeToCopyOAuthIdentity(identity, credential)
    ) {
      throw new Error("Selected request credential belongs to a different account.");
    }
  };
  return async ({ forceRefresh, signal }) => {
    assertSelected(signal);
    const store = await loadAuthProfileStoreForRuntimeAsync(params.agentDir, {
      config: params.config,
      profileId,
      migrationProvider: params.provider,
      externalCli: { mode: "none" },
    });
    assertSelected(signal);
    const credential = store.profiles[profileId];
    if (credential?.type !== "oauth") {
      throw new Error("Selected renewable profile is unavailable.");
    }
    validate(credential);
    const resolved = await resolveApiKeyForProfile({
      cfg: params.config,
      store,
      profileId,
      agentDir: params.agentDir,
      forceRefresh,
      signal,
      allowProfileFallback: false,
      validateOAuthCredential: validate,
    });
    assertSelected(signal);
    if (!resolved?.apiKey || resolved.profileId !== profileId) {
      throw new Error("Selected renewable profile did not return a request credential.");
    }
    // Formatting and refresh are asynchronous. Reacquire the canonical view so
    // removal/reconnect during either await cannot authorize the captured token.
    const current = (
      await loadAuthProfileStoreForRuntimeAsync(params.agentDir, {
        config: params.config,
        profileId,
        migrationProvider: params.provider,
        externalCli: { mode: "none" },
      })
    ).profiles[profileId];
    assertSelected(signal);
    if (
      current?.type !== "oauth" ||
      resolved.credential?.type !== "oauth" ||
      current.access !== resolved.credential.access ||
      current.refresh !== resolved.credential.refresh
    ) {
      throw new Error("Selected request credential changed during resolution.");
    }
    validate(current);
    return resolved.apiKey;
  };
}
