/** @jsxImportSource @solidjs/web */
import type { ControlUiSessionAccessory } from "openclaw/plugin-sdk/control-ui";
import { createSignal, Show } from "solid-js";
import { PresentationContext } from "./presentation-context.ts";
import { pullRequestEnglish } from "./pull-request-english.ts";
import { mountPluginContent } from "./render-owned.ts";
import type { RepositoryBrowserRuntime } from "./repository-runtime.ts";
import { SummaryRead } from "./summary-read.tsx";

export function createSummaryAccessoryMount(
  runtime: RepositoryBrowserRuntime,
): ControlUiSessionAccessory["mount"] {
  return (container, initial) => {
    let context = initial;
    const { presentation } = initial.host;
    if (!presentation) {
      throw new Error("Repository presentation services are unavailable.");
    }
    presentation.registerEnglish(pullRequestEnglish);
    presentation.registerEnglish({
      chat: {
        rail: {
          pullRequests: "Pull requests",
          checksPassing: "{count} passed",
          checksFailing: "{count} failed",
          checksPending: "{count} running",
        },
      },
    });
    const [revision, setRevision] = createSignal(0, { ownedWrite: true });
    const changed = () => {
      if (!context.signal.aborted) {
        setRevision((value) => value + 1);
      }
    };
    const owner = {};
    let key = "";
    const sync = () => {
      if (context.signal.aborted) {
        return;
      }
      if (context.signal.aborted) {
        return;
      }
      key = initial.host.sessions.artifactKey(context.props);
      runtime.store.watch(owner, context.presented && key ? [key] : [], { foreground: true });
      changed();
    };
    const stops = [
      initial.host.subscribe(sync),
      runtime.store.subscribe(changed),
      presentation.subscribe(changed),
    ];
    const requests = () => {
      revision();
      return context.presented ? (runtime.store.get(key)?.pullRequests.slice(0, 2) ?? []) : [];
    };
    const locale = {
      ...presentation,
      translate: (translationKey: string, params?: Record<string, string>) => {
        revision();
        return presentation.translate(translationKey, params);
      },
    };
    const stop = mountPluginContent(
      () => (
        <PresentationContext value={locale}>
          <Show when={requests().length}>
            <SummaryRead pullRequests={requests()} />
          </Show>
        </PresentationContext>
      ),
      container,
    );
    sync();
    return {
      update(next) {
        context = next;
        sync();
      },
      dispose() {
        stops.forEach((unsubscribe) => unsubscribe());
        runtime.store.unwatch(owner);
        stop();
      },
    };
  };
}
