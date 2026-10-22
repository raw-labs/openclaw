import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../../extensions/github-repositories/session-pull-requests-api.ts";
import type { ControlUiSessionPullRequest } from "../../../src/gateway/control-ui-contract.js";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import type { MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";
import { navigateInApp, replaceGatewayClient } from "./new-session-page.test-support.ts";
import {
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const active = "agent:main:active";
const key = "agent:main:open-pr";
const pullRequest = (number: number): ControlUiSessionPullRequest => ({
  owner: "example",
  repo: "control-ui",
  number,
  branch: "fix/action",
  url: "https://github.com/example/control-ui/pull/" + number,
  title: "Keep Open PR current",
  state: "open",
});
const rows = (worktree: boolean, sessionId = "action") => [
  sessionRow(active, "Release planning", Date.now()),
  sessionRow(key, "Open PR action", Date.now() - 1, {
    sessionId,
    ...(worktree
      ? { worktree: { id: "action", branch: "fix/action", repoRoot: "/work/control-ui" } }
      : {}),
  }),
];

async function withMenu(
  surface: "sidebar" | "sessions",
  width: number,
  worktree: boolean,
  run: (params: {
    page: Page;
    gateway: MockGatewayControls;
    item: Locator;
    open: () => Promise<void>;
    publish: (items: ControlUiSessionPullRequest[]) => Promise<void>;
  }) => Promise<void>,
) {
  await suite.withPage(
    {
      colorScheme: "dark",
      viewport: { width, height: 900 },
      recordVideo:
        captureUiProofEnabled && width === 1280 && surface === "sidebar"
          ? { dir: suite.artifactDir, size: { width, height: 900 } }
          : undefined,
    },
    async ({ page }) => {
      // Serve a labeled synthetic destination while exercising real safe new-tab navigation.
      // The route never contacts GitHub or claims a backend/publication outcome.
      await page.context().route("https://github.com/example/control-ui/pull/**", (route) => {
        const url = route.request().url();
        return route.fulfill({
          contentType: "text/html",
          body: `<title>Simulated PR destination</title><h1>Simulated PR destination</h1><p>${url}</p>`,
        });
      });
      await page.addInitScript(() => {
        localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", "[]");
        const open = window.open.bind(window);
        window.open = (url, target, features) => {
          document.documentElement.dataset.openedUrl = String(url);
          return open(url, target, features);
        };
      });
      const gateway = await installMockGateway(page, {
        sessionKey: active,
        nativePlugins: [
          {
            pluginId: "github-repositories",
            rootDir: path.resolve(import.meta.dirname, "../../../extensions/github-repositories"),
            source: "./browser/index.tsx",
          },
        ],
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "plugins.controlUi.list",
          "plugins.controlUi.report",
          SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        ],
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "plugins.controlUi.report": { ok: true },
          "sessions.list":
            surface === "sessions"
              ? {
                  cases: [
                    {
                      match: { source: "sessions-page" },
                      response: sessionsListResponse(rows(worktree)),
                    },
                    { match: {}, response: sessionsListResponse(rows(worktree).slice(0, 1)) },
                  ],
                }
              : sessionsListResponse(rows(worktree)),
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, active));
      if (surface === "sessions") {
        await navigateInApp(page, "sessions");
      } else if (width < 800) {
        await navigationDrawerToggle(page).click();
      }
      const open = async () => {
        if (surface === "sidebar") {
          const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
          if (width < 800) {
            await row.locator("[data-sidebar-session-menu]").click();
          } else {
            await row.click({ button: "right" });
          }
        } else {
          await page
            .locator(".session-data-row")
            .filter({ hasText: "Open PR action" })
            .getByRole("button", { name: "Open session menu", exact: true })
            .click();
        }
        await page.locator(".session-menu__panel").waitFor();
      };
      const publish = (items: ControlUiSessionPullRequest[]) =>
        gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: { [key]: { pullRequests: items, status: "ready", rateLimited: false } },
        });
      const item = page
        .locator("openclaw-session-menu")
        .getByRole("menuitem", { name: "Open PR", exact: true });
      await open();
      await waitForWatchedSessionKey(gateway, key);
      await run({ page, gateway, item, open, publish });
    },
  );
}

suite.define(() => {
  it("opens the current observed PR with g through the actual GitHub plugin", async () => {
    await withMenu("sidebar", 1280, true, async ({ page, gateway, item, open, publish }) => {
      await publish([pullRequest(417)]);
      await item.waitFor();
      expect(await item.count()).toBe(1);
      expect(await item.getAttribute("data-new-tab-action")).toBe("");
      expect(await item.getAttribute("aria-keyshortcuts")).toBe("G");
      await captureUiProof(
        suite,
        page,
        "open-pr-desktop.png",
        page.locator(".session-menu__panel"),
        [item],
      );
      if (captureUiProofEnabled) {
        await page.waitForTimeout(750);
      }
      await publish([pullRequest(418)]);
      const opened = page.waitForEvent("popup");
      await page.keyboard.press("g");
      const popup = await opened;
      await popup.getByRole("heading", { name: "Simulated PR destination" }).waitFor();
      expect(popup.url()).toBe(pullRequest(418).url);
      expect(await popup.evaluate(() => window.opener === null)).toBe(true);
      await captureUiProof(suite, popup, "open-pr-new-tab.png", popup.locator("body"), [
        popup.getByText(pullRequest(418).url, { exact: true }),
      ]);
      if (captureUiProofEnabled) {
        await popup.waitForTimeout(750);
      }
      await popup.close();
      await expect
        .poll(() => page.locator("html").getAttribute("data-opened-url"))
        .toBe(pullRequest(418).url);
      await open();
      await publish([]);
      await expect.poll(() => item.count()).toBe(0);
      await publish([pullRequest(419)]);
      await item.waitFor();
      // Plugin exclusion withdraws the actual registration, not just its display label.
      await gateway.setMethodResponse("plugins.controlUi.list", {
        revision: "excluded",
        plugins: [],
        diagnostics: [],
      });
      await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "excluded" });
      await expect.poll(() => item.count()).toBe(0);
      await page.keyboard.press("g");
      expect(await page.locator("html").getAttribute("data-opened-url")).toBe(pullRequest(418).url);
    });
  });

  it.each([
    { surface: "sidebar", width: 600 },
    { surface: "sessions", width: 1280 },
    { surface: "sessions", width: 600 },
  ] as const)(
    "releases menu interest and re-resolves after reopen: $surface $width",
    async ({ surface, width }) => {
      await withMenu(surface, width, false, async ({ page, gateway, item, open, publish }) => {
        expect(await item.count()).toBe(0);
        await publish([pullRequest(421)]);
        await item.waitFor();
        await captureUiProof(
          suite,
          page,
          `open-pr-${surface}-${width}.png`,
          page.locator(".session-menu__panel"),
          [item],
        );
        await item.click();
        await expect
          .poll(() => page.locator("html").getAttribute("data-opened-url"))
          .toBe(pullRequest(421).url);
        // Foreground menu interest retires; the Sessions-only target has no passive reader.
        await expect
          .poll(async () => {
            const params = (await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD)).at(
              -1,
            )?.params;
            return params && typeof params === "object" && "sessionKeys" in params
              ? params.sessionKeys
              : null;
          })
          .not.toContain(key);
        await open();
        await waitForWatchedSessionKey(gateway, key);
        if (surface === "sessions") {
          expect(await item.count()).toBe(0);
        }
        await publish([pullRequest(422)]);
        await item.waitFor();
        await page.keyboard.press("g");
        await expect
          .poll(() => page.locator("html").getAttribute("data-opened-url"))
          .toBe(pullRequest(422).url);
        if (surface === "sessions" && width === 1280) {
          await open();
          await publish([pullRequest(423)]);
          await item.waitFor();
          await replaceGatewayClient(page);
          await expect.poll(() => item.count()).toBe(0);
          await page.keyboard.press("g");
          expect(await page.locator("html").getAttribute("data-opened-url")).toBe(
            pullRequest(422).url,
          );
        }
      });
    },
  );
});
