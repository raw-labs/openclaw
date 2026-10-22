import {
  mountMobilePullRequestRow,
  mountMobilePullRequestRecovery,
  mountMobilePullRequestCollection,
  mountMobilePullRequestDetail,
  mountMobilePullRequestChecks,
  mountMobilePullRequestMonitoring,
  type ChatPullRequestMobileRowProps,
  type ChatPullRequestMobileRecoveryProps,
  type ChatPullRequestMobileCollectionProps,
  type ChatPullRequestMobileDetailProps,
  type ChatPullRequestMobileCiProps as PluginMobileCiProps,
} from "../../../../../extensions/github-repositories/browser/read-presentation-api.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { repositoryReadCi } from "../../../plugins/repository-read-ci.tsx";
import { repositoryReadView } from "../../../plugins/repository-read-view.tsx";

export type {
  ChatPullRequestMobileRowProps,
  ChatPullRequestMobileRecoveryProps,
  ChatPullRequestMobileCollectionProps,
  ChatPullRequestMobileDetailProps,
} from "../../../../../extensions/github-repositories/browser/read-presentation-api.ts";
export type ChatPullRequestMobileCiProps = PluginMobileCiProps & { gateway?: ApplicationGateway };

// Project only this library's values; callers may compose these from wider native props.
function recoveryFacts(props: ChatPullRequestMobileRecoveryProps) {
  return {
    status: props.status,
    hasSnapshot: props.hasSnapshot,
    lastUpdatedAt: props.lastUpdatedAt,
    retrying: props.retrying,
    onRetry: props.onRetry,
  };
}

export function ChatPullRequestMobileRow(props: ChatPullRequestMobileRowProps) {
  return repositoryReadView(mountMobilePullRequestRow, () => ({
    pullRequest: props.pullRequest,
    onOpen: props.onOpen,
  }));
}
export function ChatPullRequestMobileRecovery(
  props: ChatPullRequestMobileRecoveryProps & { collection?: boolean },
) {
  return repositoryReadView(mountMobilePullRequestRecovery, () => ({
    ...recoveryFacts(props),
    collection: props.collection,
  }));
}
export function ChatPullRequestMobileCollection(props: ChatPullRequestMobileCollectionProps) {
  return repositoryReadView(mountMobilePullRequestCollection, () => ({
    ...recoveryFacts(props),
    pullRequests: props.pullRequests,
    onOpen: props.onOpen,
  }));
}
export function ChatPullRequestMobileDetail(props: ChatPullRequestMobileDetailProps) {
  return repositoryReadView(mountMobilePullRequestDetail, () => ({
    ...recoveryFacts(props),
    pullRequest: props.pullRequest,
    dismissDisabled: props.dismissDisabled,
    onOpenChecks: props.onOpenChecks,
    onOpenMonitoring: props.onOpenMonitoring,
    onDismiss: props.onDismiss,
  }));
}
export function ChatPullRequestMobileChecks(props: ChatPullRequestMobileCiProps) {
  return repositoryReadView(
    mountMobilePullRequestChecks,
    () => ({
      pullRequest: props.pullRequest,
      sessionKey: props.sessionKey,
      sessionId: props.sessionId,
      presented: props.presented,
      ...recoveryFacts(props),
    }),
    repositoryReadCi(() => props.gateway),
  );
}
export function ChatPullRequestMobileMonitoring(props: ChatPullRequestMobileCiProps) {
  return repositoryReadView(
    mountMobilePullRequestMonitoring,
    () => ({
      pullRequest: props.pullRequest,
      sessionKey: props.sessionKey,
      sessionId: props.sessionId,
      presented: props.presented,
      ...recoveryFacts(props),
    }),
    repositoryReadCi(() => props.gateway),
  );
}
