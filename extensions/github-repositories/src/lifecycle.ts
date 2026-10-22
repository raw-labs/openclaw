import { readRepositoryPersistedConfig } from "openclaw/plugin-sdk/config-mutation";
import type { OpenClawPluginServiceV2 } from "openclaw/plugin-sdk/plugin-entry";
import type { RepositoryPublicationApi } from "openclaw/plugin-sdk/repository-publication-engine";
import {
  captureRepositoryServiceHost,
  installRepositoryPublicationProvider,
} from "openclaw/plugin-sdk/repository-session-host";
import { installRepositorySource } from "openclaw/plugin-sdk/repository-sources";
import { installRepositoryServices } from "../account-runtime-api.js";
import { createGitHubOAuthLifecycle } from "../oauth-lifecycle-runtime-api.js";
import { createGitHubPublicationProvider } from "../publication-provider-api.js";
import { createGitHubRepositorySource } from "../repository-source-api.js";
import { startGitHubSessionPresentation } from "../session-presentation-service-api.js";
import { cleanupRetiredManagedGitHubProfiles } from "../tool-profile-cleanup-api.js";

/** The managed plugin service is the sole account maintenance owner. */
export function createRepositoryAccountService(
  instanceSignal: AbortSignal,
): OpenClawPluginServiceV2 {
  let stop: (() => Promise<void>) | undefined;
  return {
    apiVersion: 2,
    id: "github-repositories.accounts",
    async start(service) {
      const host = captureRepositoryServiceHost();
      if (!host) {
        throw new Error("GitHub account service requires an active Gateway service binding.");
      }
      const signal = AbortSignal.any([service.scheduler.signal, instanceSignal, host.identity]);
      const assertCurrent = () => {
        signal.throwIfAborted();
        host.assertCurrent();
      };
      assertCurrent();
      try {
        const cleanup = await cleanupRetiredManagedGitHubProfiles({
          config: host.getConfig(),
          env: process.env,
        });
        for (const warning of cleanup.warnings) {
          service.logger.warn(`managed GitHub profile cleanup: ${warning}`);
        }
      } catch (error) {
        service.logger.warn(
          `managed GitHub profile cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      assertCurrent();
      let oauth: ReturnType<typeof createGitHubOAuthLifecycle> | undefined = undefined;
      let uninstall: (() => void) | undefined = undefined;
      let presentation: ReturnType<typeof startGitHubSessionPresentation> | undefined = undefined;
      let uninstallSource: (() => void) | undefined = undefined;
      let publication: RepositoryPublicationApi | undefined;
      let uninstallPublication: (() => void) | undefined;
      // Failed startup retains custody before a constructor can acquire subscriptions.
      stop = async () => {
        uninstallSource?.();
        uninstallPublication?.();
        uninstall?.();
        await Promise.all([oauth?.stop(), presentation?.stop()]);
      };
      oauth = createGitHubOAuthLifecycle({
        scheduler: service.scheduler,
        getConfig: host.getConfig,
        getPersistedConfig: readRepositoryPersistedConfig,
        warn: (message) => service.logger.warn(message),
      });
      const currentOauth = oauth;
      if (host.publicationAvailable) {
        const installed = await installRepositoryPublicationProvider(
          createGitHubPublicationProvider({
            signal,
            assertCurrent,
            getConfig: host.getConfig,
            refreshIdentity: (agentId) => currentOauth.refreshEffectiveIdentity(agentId),
            refreshPersonal: (owner) => currentOauth.personal.refresh(owner),
          }),
        );
        uninstallPublication = installed.uninstall;
        publication = installed.api;
        assertCurrent();
      }
      presentation = startGitHubSessionPresentation({
        scheduler: service.scheduler,
        getConfig: host.getConfig,
      });
      uninstall = installRepositoryServices(host.identity, { oauth, publication }, signal);
      uninstallSource = installRepositorySource(
        createGitHubRepositorySource(host.getConfig, async (agentId) => {
          assertCurrent();
          await oauth?.refreshEffectiveIdentity(agentId);
          assertCurrent();
        }),
      );
      oauth.start();
    },
    async stop() {
      await stop?.();
      stop = undefined;
    },
  };
}
