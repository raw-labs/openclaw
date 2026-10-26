/** @jsxImportSource @solidjs/web */

import type { CronJob } from "@openclaw/gateway-protocol";
import { createMemo, createUniqueId, For, Show } from "solid-js";
import { Icon, type MenuControls } from "./presentation-components.tsx";
import { presentationTranslator } from "./presentation-context.ts";
import type { CiAutomationOption, CiAutomationOptions } from "./session-pr-automation-spec.ts";
import type { CiAutomationJobs } from "./session-pr-automation.ts";

export type ChatCiAutomationProps = {
  options: CiAutomationOptions;
  pending: Partial<CiAutomationOptions>;
  jobs?: CiAutomationJobs;
  schedulerEnabled?: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  disabled?: boolean;
  disabledReason?: string;
  retryDisabled?: boolean;
  menuPresentation?: boolean;
  controls?: MenuControls;
  onChange: (option: CiAutomationOption, enabled: boolean) => void;
  onRetry: () => void;
};
const OPTIONS = [
  ["autoFix", "chat.pullRequests.automationAutoFix"],
  ["autoMerge", "chat.pullRequests.automationAutoMerge"],
  ["autoArchive", "chat.pullRequests.automationAutoArchive"],
] as const;
const MENU_OPTIONS = {
  autoFix: { icon: "wrench", descriptionKey: "chat.pullRequests.automationAutoFixDescription" },
  autoMerge: {
    icon: "gitMerge",
    descriptionKey: "chat.pullRequests.automationAutoMergeDescription",
  },
  autoArchive: {
    icon: "archive",
    descriptionKey: "chat.pullRequests.automationAutoArchiveDescription",
  },
} as const;

function JobError(props: { job?: CronJob }) {
  const t = presentationTranslator();
  return (
    <Show when={props.job?.state.autoDisabled || props.job?.state.lastError}>
      <div class="chat-ci__automation-job-error" role="status">
        <Show when={props.job?.state.autoDisabled}>
          {(disabled) => (
            <div>
              {t(
                disabled().reason === "schedule-errors"
                  ? "chat.pullRequests.automationScheduleDisabled"
                  : "chat.pullRequests.automationFailureDisabled",
                { count: String(disabled().consecutiveErrors) },
              )}
            </div>
          )}
        </Show>
        <Show when={props.job?.state.lastError}>
          {(error) => <div>{t("chat.pullRequests.automationLastError", { error: error() })}</div>}
        </Show>
      </div>
    </Show>
  );
}

export function ChatCiAutomationView(props: ChatCiAutomationProps) {
  const retryRef = createMemo(() => props.controls?.ref());
  const t = presentationTranslator();
  return (
    <div class="chat-ci__automation">
      <fieldset
        class="chat-ci__automation-options"
        aria-label={t("chat.pullRequests.automationLabel")}
        disabled={props.disabled}
      >
        <For each={OPTIONS}>
          {(entry) => {
            const inputRef = createMemo(() => props.controls?.ref());
            return (
              <div class="chat-ci__automation-row">
                <Show
                  when={props.menuPresentation}
                  fallback={
                    <label class="chat-ci__automation-option">
                      <input
                        ref={(element) => inputRef()?.(element)}
                        class="chat-ci__automation-checkbox"
                        type="checkbox"
                        name={entry[0]}
                        checked={props.options[entry[0]]}
                        disabled={props.pending[entry[0]] !== undefined}
                        onChange={(event) => props.onChange(entry[0], event.currentTarget.checked)}
                      />
                      <span class="chat-ci__automation-label">{t(entry[1])}</span>
                    </label>
                  }
                >
                  <label class="chat-ci__automation-option chat-ci__automation-option--menu">
                    <Icon name={MENU_OPTIONS[entry[0]].icon} />
                    <span class="chat-ci__automation-label">
                      {t(
                        entry[0] === "autoArchive"
                          ? "chat.pullRequests.automationAutoArchiveSession"
                          : entry[1],
                      )}
                      <span class="chat-ci__automation-description">
                        {t(MENU_OPTIONS[entry[0]].descriptionKey)}
                      </span>
                    </span>
                    <NativeSettingsToggle
                      inputRef={inputRef()}
                      ariaLabel={t(
                        entry[0] === "autoArchive"
                          ? "chat.pullRequests.automationAutoArchiveSession"
                          : entry[1],
                      )}
                      checked={props.options[entry[0]]}
                      disabled={props.disabled || props.pending[entry[0]] !== undefined}
                      onChange={(enabled) => props.onChange(entry[0], enabled)}
                    />
                  </label>
                </Show>
                <JobError job={props.jobs?.[entry[0]]} />
              </div>
            );
          }}
        </For>
      </fieldset>
      <Show when={props.schedulerEnabled === false}>
        <p class="chat-ci__automation-warning" role="status">
          {t("chat.pullRequests.automationSchedulerDisabled")}
        </p>
      </Show>
      <Show when={props.disabledReason}>
        {(reason) => (
          <div class="chat-ci__automation-status" role="status">
            {reason()}
          </div>
        )}
      </Show>
      <Show when={props.error}>
        {(error) => (
          <div class="chat-ci__automation-error">
            <span role="alert">{error()}</span>
            <button
              ref={(element) => retryRef()?.(element)}
              class="chat-ci__automation-retry"
              type="button"
              disabled={props.loading || props.saving || props.retryDisabled}
              onClick={() => props.onRetry()}
            >
              {t("chat.pullRequests.automationRetry")}
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}

/** Plugin-owned native control preserves the shared toggle's DOM and keyboard behavior. */
function NativeSettingsToggle(props: {
  inputRef?: (element: HTMLInputElement) => void;
  ariaLabel: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const labelId = `github-ci-toggle-${createUniqueId()}`;
  return (
    <span class="settings-toggle">
      <input
        ref={(element) => props.inputRef?.(element)}
        class="settings-toggle__input"
        type="checkbox"
        role="switch"
        checked={props.checked}
        disabled={props.disabled}
        aria-labelledby={labelId}
        onChange={(event) => {
          const input = event.currentTarget;
          if (input.matches(":disabled") || props.disabled) {
            input.checked = props.checked;
            return;
          }
          props.onChange(input.checked);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
            return;
          }
          const input = event.currentTarget;
          if (input.matches(":disabled") || props.disabled) {
            return;
          }
          event.preventDefault();
          const checked =
            (event.key === "ArrowRight") !== (getComputedStyle(input).direction === "rtl");
          if (checked === input.checked) {
            return;
          }
          input.checked = checked;
          props.onChange(checked);
        }}
      />
      <span class="settings-toggle__control" aria-hidden="true" />
      <span id={labelId} class="settings-control__sr-label">
        {props.ariaLabel}
      </span>
    </span>
  );
}
