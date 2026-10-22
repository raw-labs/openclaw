/** @jsxImportSource @solidjs/web */

import { createMemo, createSignal, createStore, useContext, createEffect } from "solid-js";
import {
  ChatCiAutomationView,
  type ChatCiAutomationProps as ChatCiAutomationViewProps,
} from "./chat-ci-automation.tsx";
import { createCiDisclosure, type ChatCiDisclosureProps } from "./chat-ci-disclosure.ts";
import { RepositoryCiContext } from "./ci-context.ts";
import type { MenuControls } from "./presentation-components.tsx";
import { PresentationContext, presentationTranslator } from "./presentation-context.ts";
import type {
  CiAutomationOption,
  CiAutomationOptions,
  CiAutomationTarget,
} from "./session-pr-automation-spec.ts";
import { createCiAutomationApi, type CiAutomationJobs } from "./session-pr-automation.ts";

type CronStatus = {
  enabled: boolean;
  triggersEnabled: boolean;
  jobs: number;
  nextWakeAtMs?: number | null;
};

export type ChatCiAutomationProps = ChatCiDisclosureProps & {
  sessionId: string;
  menuPresentation?: boolean;
  controls?: MenuControls;
};
export function ChatCiAutomation(props: ChatCiAutomationProps) {
  const services = useContext(RepositoryCiContext);
  const presentation = useContext(PresentationContext);
  const formatUiError = presentation.formatError;
  const { loadCiAutomationJobs, setCiAutomationEnabled } = createCiAutomationApi(
    presentation.declarationDigest,
  );
  let element!: HTMLElement;
  type Props = ChatCiAutomationProps;
  type AutomationState = {
    jobs: CiAutomationJobs;
    pending: Partial<CiAutomationOptions>;
    loading: boolean;
    loaded: boolean;
    schedulerEnabled: boolean | undefined;
    error: string | null;
  };

  function createCiAutomation() {
    const t = presentationTranslator();
    const [state, setState] = createStore<AutomationState>({
      jobs: {},
      pending: {},
      loading: false,
      loaded: false,
      schedulerEnabled: undefined,
      error: null,
    });
    const [connectionPulse, setConnectionPulse] = createSignal(0);
    let connectionRevision = -1;
    let version = 0;
    let inventoryVersion = -1;
    let readController: AbortController | undefined;
    let refreshPending = true;
    let stopGateway: (() => void) | undefined;
    let boundRequests: typeof services.requests | undefined;
    let stopEvents: (() => void) | undefined;
    let targetKey = "";
    let sessionKey = "";
    let sessionId = "";
    // Synchronous admission is separate from Solid's deferred presentation writes.
    const writes = new Set<CiAutomationOption>();
    const disclosure = createCiDisclosure(
      () => element,
      () => props,
      handleVisibility,
      () => {
        bindGateway();
        syncTarget();
        return () => {
          stopGateway?.();
          stopEvents?.();
          version += 1;
          readController?.abort();
        };
      },
    );

    function bindGateway() {
      boundRequests = services.requests;
      stopGateway?.();
      stopEvents?.();
      const source = services.requests;
      reset();
      // Retire request authority on every connection transition, before subsequent events.
      stopGateway = source?.subscribe(() => {
        syncConnection();
        queueRefresh();
      });
      stopEvents = source?.subscribeEvents((event) => {
        if (event.event === "cron" || event.event === "config.changed") {
          invalidate();
        }
      });
      syncConnection();
      queueRefresh();
    }

    function syncTarget() {
      const next = JSON.stringify([props.sessionKey, props.sessionId, automationTarget()]);
      if (targetKey === next) {
        return false;
      }
      if (
        (sessionKey && sessionKey !== props.sessionKey) ||
        (sessionId && sessionId !== props.sessionId)
      ) {
        disclosure.close();
      }
      targetKey = next;
      sessionKey = props.sessionKey;
      sessionId = props.sessionId;
      reset();
      return true;
    }

    let previousVisibility: boolean | undefined;
    function syncInputs() {
      if (boundRequests !== services.requests) {
        bindGateway();
      }
      const targetChanged = syncTarget();
      const visibility = disclosure.visible();
      const visibilityChanged = previousVisibility !== visibility;
      previousVisibility = visibility;
      if (targetChanged || visibilityChanged) {
        handleVisibility();
      }
    }
    function queueRefresh() {
      queueMicrotask(() => {
        if (refreshPending && disclosure.visible() && !readController && !writes.size) {
          void load();
        }
      });
    }

    function automationTarget(source: Props = props): CiAutomationTarget | null {
      const pr = source.pullRequest;
      const agentId = services.agentId(source.sessionKey);
      if (!pr || !agentId || !source.sessionId.trim()) {
        return null;
      }
      return {
        sessionKey: source.sessionKey,
        sessionId: source.sessionId,
        agentId,
        owner: pr.owner.toLowerCase(),
        repo: pr.repo.toLowerCase(),
        number: pr.number,
      };
    }

    function canRead(): boolean {
      return ["cron.list", "cron.status"].every((method) =>
        services.requests?.canCall(method, "operator.read", false),
      );
    }
    function canManage(): boolean {
      return ["cron.add", "cron.update"].every((method) =>
        services.requests?.canCall(method, "operator.admin", false),
      );
    }
    function syncConnection(): void {
      const revision = services.requests?.revision ?? -1;
      if (revision !== connectionRevision) {
        connectionRevision = revision;
        setConnectionPulse((value) => value + 1);
        reset();
      }
    }

    function cancelRead(): void {
      if (!readController) {
        return;
      }
      readController.abort();
      readController = undefined;
      setState((draft) => {
        draft.loading = false;
      });
      refreshPending = true;
    }

    function reset(): void {
      version += 1;
      cancelRead();
      inventoryVersion = -1;
      writes.clear();
      setState((draft) => {
        draft.jobs = {};
        draft.loaded = false;
        draft.pending = {};
        draft.schedulerEnabled = undefined;
        draft.error = null;
      });
      refreshPending = true;
    }

    function invalidate(): void {
      // One trailing authoritative read absorbs event bursts and in-flight writes.
      refreshPending = true;
      queueRefresh();
    }

    function handleVisibility(): void {
      if (!disclosure.visible()) {
        cancelRead();
      }
      invalidate();
    }

    function capture() {
      const gateway = services.requests;
      const scope = services.requests?.capture();
      const target = automationTarget();
      const pullRequest = props.pullRequest;
      if (!gateway || !scope || !target || !pullRequest) {
        return null;
      }
      const capturedVersion = version;
      const input = {
        sessionKey: props.sessionKey,
        sessionId: props.sessionId,
        // Cron declarations follow the PR, not an individual head revision.
        pullRequest: {
          owner: pullRequest.owner,
          repo: pullRequest.repo,
          number: pullRequest.number,
        },
      };
      return {
        client: scope,
        target,
        current: () =>
          disclosure.isConnected() &&
          capturedVersion === version &&
          services.isCurrent(input) &&
          gateway === services.requests &&
          scope.isCurrent(),
      };
    }

    async function load(): Promise<void> {
      if (!disclosure.visible() || readController || writes.size) {
        return;
      }
      refreshPending = false;
      const owner = capture();
      if (!owner || !owner.current() || !canRead()) {
        queueRefresh();
        return;
      }
      const controller = new AbortController();
      readController = controller;
      setState((draft) => {
        draft.loading = true;
      });
      queueRefresh();
      const current = () =>
        owner.current() && disclosure.visible() && readController === controller;
      try {
        const [jobs, status] = await Promise.all([
          loadCiAutomationJobs(owner.client, owner.target, controller.signal),
          owner.client.request<CronStatus>("cron.status", {}, { signal: controller.signal }),
        ]);
        if (current()) {
          inventoryVersion = version;
          setState((draft) => {
            draft.jobs = jobs;
            draft.schedulerEnabled = status.enabled;
            draft.loaded = true;
          });
        }
      } catch (error) {
        if (current()) {
          inventoryVersion = -1;
          setState((draft) => {
            draft.loaded = false;
            draft.error = formatUiError(error, t("chat.pullRequests.automationLoadFailed"));
          });
        }
      } finally {
        if (current()) {
          setState((draft) => {
            draft.loading = false;
          });
          readController = undefined;
          queueRefresh();
        }
      }
    }

    async function setEnabled(option: CiAutomationOption, enabled: boolean): Promise<void> {
      if (syncTarget()) {
        return;
      }
      if (
        !disclosure.visible() ||
        inventoryVersion !== version ||
        writes.has(option) ||
        !canRead() ||
        !canManage()
      ) {
        return;
      }
      const owner = capture();
      if (!owner || !owner.current()) {
        return;
      }
      // A pre-click inventory must never overwrite newer intent or its acknowledged revision.
      cancelRead();
      writes.add(option);
      setState((draft) => {
        draft.pending[option] = enabled;
        draft.error = null;
      });
      queueRefresh();
      try {
        const job = await setCiAutomationEnabled(
          owner.client,
          owner.target,
          option,
          enabled,
          state.jobs[option],
        );
        if (!owner.current()) {
          return;
        }
        setState((draft) => {
          draft.jobs[option] = job;
        });
      } catch (error) {
        if (owner.current()) {
          // A rejected acknowledgement may hide an accepted write. Never mutate again
          // until a complete authoritative inventory has reconciled the actual outcome.
          inventoryVersion = -1;
          setState((draft) => {
            draft.loaded = false;
            draft.error = formatUiError(error, t("chat.pullRequests.automationSaveFailed"));
          });
        }
      } finally {
        if (owner.current()) {
          writes.delete(option);
          setState((draft) => {
            delete draft.pending[option];
          });
          queueRefresh();
        }
      }
    }

    const view = createMemo<ChatCiAutomationViewProps>(() => {
      connectionPulse();
      const unavailable = !automationTarget(props)
        ? t("chat.pullRequests.automationSessionRequired")
        : !canRead()
          ? t("chat.pullRequests.automationReadRequired")
          : !canManage()
            ? t("chat.pullRequests.automationAdminRequired")
            : undefined;
      return {
        options: {
          autoFix: state.pending.autoFix ?? state.jobs.autoFix?.enabled === true,
          autoMerge: state.pending.autoMerge ?? state.jobs.autoMerge?.enabled === true,
          autoArchive: state.pending.autoArchive ?? state.jobs.autoArchive?.enabled === true,
        },
        jobs: state.jobs,
        pending: state.pending,
        schedulerEnabled: state.schedulerEnabled,
        loading: state.loading,
        saving: Object.keys(state.pending).length > 0,
        error: state.error,
        disabled: Boolean(unavailable) || !state.loaded,
        disabledReason: unavailable,
        retryDisabled: !automationTarget(props) || !canRead(),
        onChange: (option, enabled) => void setEnabled(option, enabled),
        onRetry: () => {
          setState((draft) => {
            draft.error = null;
          });
          invalidate();
        },
      };
    });
    return { view, syncInputs };
  }

  const model = createCiAutomation();
  createEffect(
    () => [
      services.requests,
      props.sessionKey,
      props.sessionId,
      props.pullRequest,
      props.presented,
      props.inline,
    ],
    () => model.syncInputs(),
  );
  return (
    <openclaw-chat-ci-automation ref={(node) => (element = node)}>
      <ChatCiAutomationView
        {...model.view()}
        menuPresentation={props.menuPresentation}
        controls={props.controls}
      />
    </openclaw-chat-ci-automation>
  );
}
