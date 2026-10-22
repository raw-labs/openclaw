import { ActivityRead } from "./activity-read.tsx";
import {
  ChatPullRequestMobileRow,
  ChatPullRequestMobileRecovery,
  ChatPullRequestMobileCollection,
  ChatPullRequestMobileDetail,
  ChatPullRequestMobileChecks,
  ChatPullRequestMobileMonitoring,
} from "./chat-pull-request-mobile.tsx";
/** Read-renderer library; native composition retains the one connection read owner in this prefix. */
import { ChatPullRequestRows } from "./chat-pull-requests-content.tsx";
import { PullRequestDetails } from "./hovercard-read.tsx";
import { readView } from "./read-view.tsx";
import { SummaryRead } from "./summary-read.tsx";

export type { RepositoryReadServices } from "./read-view.tsx";
export type { CiReadProps } from "./read-ci.tsx";
export type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
export type {
  ChatPullRequestMobileRecoveryProps,
  ChatPullRequestMobileRowProps,
  ChatPullRequestMobileCollectionProps,
  ChatPullRequestMobileDetailProps,
  ChatPullRequestMobileCiProps,
} from "./chat-pull-request-mobile.tsx";
export const mountPullRequestRows =
  readView<Parameters<typeof ChatPullRequestRows>[0]>(ChatPullRequestRows);
export const mountHovercardPullRequests =
  readView<Parameters<typeof PullRequestDetails>[0]>(PullRequestDetails);
export const mountMobilePullRequestRow =
  readView<Parameters<typeof ChatPullRequestMobileRow>[0]>(ChatPullRequestMobileRow);
export const mountMobilePullRequestRecovery = readView<
  Parameters<typeof ChatPullRequestMobileRecovery>[0]
>(ChatPullRequestMobileRecovery);
export const mountMobilePullRequestCollection = readView<
  Parameters<typeof ChatPullRequestMobileCollection>[0]
>(ChatPullRequestMobileCollection);
export const mountMobilePullRequestDetail = readView<
  Parameters<typeof ChatPullRequestMobileDetail>[0]
>(ChatPullRequestMobileDetail);
export const mountMobilePullRequestChecks = readView<
  Parameters<typeof ChatPullRequestMobileChecks>[0]
>(ChatPullRequestMobileChecks);
export const mountMobilePullRequestMonitoring = readView<
  Parameters<typeof ChatPullRequestMobileMonitoring>[0]
>(ChatPullRequestMobileMonitoring);

export const mountActivityRead = readView<Parameters<typeof ActivityRead>[0]>(ActivityRead);
export const mountSummaryRead = readView<Parameters<typeof SummaryRead>[0]>(SummaryRead);
