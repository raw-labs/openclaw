import { expect, it } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../../extensions/github-repositories/session-pull-requests-api.ts";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import type { ControlUiLinkReaderDescriptor } from "../../../src/shared/control-ui-link-reader.js";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  GITHUB_REFERENCE_PLUGIN,
  GITHUB_REFERENCE_READER,
} from "./github-link-hovercard.test-support.ts";
import { captureUiProof } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "GitHub text references" });
const source =
  "Synthetic reference example: PR acme/current#24. Code: `PR acme/current#24`. [Existing link](https://github.com/acme/current/pull/26).";

suite.define(() => {
  it("leaves shorthand as prose when its same-plugin reader is not admitted", async () => {
    await suite.withPage(
      { colorScheme: "dark", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          nativePlugins: [GITHUB_REFERENCE_PLUGIN],
          historyMessages: [{ role: "assistant", content: [{ type: "text", text: source }] }],
          methodResponses: { "plugins.controlUi.report": { ok: true } },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const message = page
          .locator(".chat-text")
          .filter({ hasText: "Synthetic reference example" });
        await message.waitFor();
        await captureUiProof(suite, page, "reader-not-admitted.png", message, [message]);
        expect(await message.locator("a.markdown-github-item").count()).toBe(0);
        expect(
          await message
            .getByRole("link", { name: "Existing link", exact: true })
            .getAttribute("href"),
        ).toBe("https://github.com/acme/current/pull/26");
      },
    );
  });
  it.each([false, true])(
    "observes current aliases and reader withdrawal in transcript and detail (mobile=%s)",
    async (mobile) => {
      const viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 };
      await suite.withPage(
        {
          colorScheme: "dark",
          viewport,
          ...(!mobile ? { recordVideo: { dir: suite.artifactDir, size: viewport } } : {}),
        },
        async ({ page }) => {
          const prose =
            "Synthetic observed references: Current PR #24. Named Widget PR #25. Code: `PR #24`. [Existing link](https://github.com/acme/current/pull/26).";
          const methods = [
            ...defaultControlUiFeatureMethods,
            SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
            "projects.list",
            "github.detail",
            "github.preview",
            "plugins.controlUi.list",
            "plugins.controlUi.report",
            "plugins.uiDescriptors",
          ];
          const aliases = {
            projects: [
              {
                id: "widget",
                displayName: "Widget",
                originUrl: "https://github.com/acme/widget",
                source: "registered",
              },
            ],
          };
          const gateway = await installMockGateway(page, {
            featureMethods: methods,
            controlUiLinkReaders: [GITHUB_REFERENCE_READER],
            nativePlugins: [GITHUB_REFERENCE_PLUGIN],
            deferredMethods: ["projects.list"],
            historyMessages: [
              {
                role: "assistant",
                content: [{ type: "text", text: prose + " Review `notes.md`." }],
              },
            ],
            methodResponses: {
              [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
              "projects.list": aliases,
              "plugins.controlUi.report": { ok: true },
              "sessions.files.get": {
                sessionKey: "agent:main:main",
                root: "/workspace",
                file: {
                  name: "notes.md",
                  path: "notes.md",
                  workspacePath: "notes.md",
                  kind: "read",
                  missing: false,
                  previewKind: "text",
                  contentEncoding: "utf8",
                  content: prose,
                },
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const key = await waitForWatchedSessionKey(gateway);
          const publishRepository = (repo: string) =>
            gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
              sessions: {
                [key]: {
                  repository: { owner: "acme", repo },
                  pullRequests: [],
                  rateLimited: false,
                  status: "ready",
                },
              },
            });
          await publishRepository("current");
          const message = page
            .locator(".chat-text")
            .filter({ hasText: "Synthetic observed references" });
          await message.waitFor();
          await gateway.waitForRequest("projects.list");
          expect(
            await message.locator('a[href="https://github.com/acme/current/pull/24"]').count(),
          ).toBe(0);
          expect(
            await message.locator('a[href="https://github.com/acme/widget/pull/25"]').count(),
          ).toBe(0);
          await gateway.resolveDeferred("projects.list");
          await expect
            .poll(() =>
              message.locator('a[href="https://github.com/acme/current/pull/24"]').count(),
            )
            .toBe(1);
          await expect
            .poll(() => message.locator('a[href="https://github.com/acme/widget/pull/25"]').count())
            .toBe(1);
          expect(await message.locator("code").first().textContent()).toBe("PR #24");
          expect(
            await message
              .getByRole("link", { name: "Existing link", exact: true })
              .getAttribute("href"),
          ).toBe("https://github.com/acme/current/pull/26");
          await captureUiProof(
            suite,
            page,
            mobile ? "mobile-observed.png" : "desktop-observed.png",
            message,
            [message],
          );
          await message.locator('a[data-file-path="notes.md"]').click();
          const detail = page.locator(".sidebar-file-view");
          await expect
            .poll(() => detail.locator('a[href="https://github.com/acme/widget/pull/25"]').count())
            .toBe(1);
          expect((await gateway.getRequests("projects.list")).length).toBe(1);
          await captureUiProof(
            suite,
            page,
            mobile ? "mobile-detail.png" : "desktop-detail.png",
            detail,
            [detail],
          );
          await publishRepository("replacement");
          await expect
            .poll(() =>
              detail.locator('a[href="https://github.com/acme/replacement/pull/24"]').count(),
            )
            .toBe(1);
          const descriptors = (generation: number, readers: ControlUiLinkReaderDescriptor[]) => ({
            ok: true,
            generation,
            descriptors: [],
            methods,
            controlUiTabs: [],
            controlUiWidgetKinds: [],
            pluginSurfaceUrls: {},
            controlUiLinkReaders: readers,
          });
          // Reader removal invalidates both visible consumers without disposing the browser plugin.
          await gateway.setMethodResponse("plugins.uiDescriptors", descriptors(1, []));
          await gateway.emitGatewayEvent("plugins.changed", { generation: 1 });
          await expect.poll(() => detail.locator("a.markdown-github-item").count()).toBe(0);
          expect(await detail.textContent()).toContain("Current PR #24");
          await captureUiProof(
            suite,
            page,
            mobile ? "mobile-withdrawn.png" : "desktop-withdrawn.png",
            detail,
            [detail],
          );
          // A foreign plugin's equivalent reader cannot admit this plugin's grammar.
          await gateway.setMethodResponse(
            "plugins.uiDescriptors",
            descriptors(2, [{ ...GITHUB_REFERENCE_READER, pluginId: "foreign" }]),
          );
          await gateway.emitGatewayEvent("plugins.changed", { generation: 2 });
          expect(await detail.locator("a.markdown-github-item").count()).toBe(0);
          await gateway.setMethodResponse(
            "plugins.uiDescriptors",
            descriptors(3, [GITHUB_REFERENCE_READER]),
          );
          await gateway.emitGatewayEvent("plugins.changed", { generation: 3 });
          await expect
            .poll(async () => (await gateway.getRequests("projects.list")).length)
            .toBe(2);
          await expect
            .poll(() => detail.locator('a[href="https://github.com/acme/widget/pull/25"]').count())
            .toBe(1);
          if (!mobile) {
            // A failed refresh cannot keep the old catalog or guess the current checkout.
            await gateway.deferNext("projects.list");
            await gateway.emitGatewayEvent("config.changed", {});
            await gateway.waitForRequest("projects.list", { after: 2 });
            await gateway.rejectDeferred("projects.list", {
              code: "UNAVAILABLE",
              message: "Synthetic alias read failure",
            });
            await expect.poll(() => detail.locator("a.markdown-github-item").count()).toBe(0);
            await gateway.emitGatewayEvent("config.changed", {});
            await expect
              .poll(() =>
                detail.locator('a[href="https://github.com/acme/widget/pull/25"]').count(),
              )
              .toBe(1);
          }
          const priorAliasReads = (await gateway.getRequests("projects.list")).length;
          // A superseded alias response cannot revive facts after the provider is withdrawn.
          await gateway.deferNext("projects.list");
          await gateway.emitGatewayEvent("config.changed", {});
          await expect
            .poll(async () => (await gateway.getRequests("projects.list")).length)
            .toBe(priorAliasReads + 1);
          await gateway.setMethodResponse("plugins.controlUi.list", {
            plugins: [],
            diagnostics: [],
            revision: "excluded",
          });
          await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "excluded" });
          await expect.poll(() => detail.locator("a.markdown-github-item").count()).toBe(0);
          await gateway.resolveDeferred("projects.list", aliases);
          expect(await detail.locator("a.markdown-github-item").count()).toBe(0);
        },
      );
    },
  );
});
