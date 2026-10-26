import {
  GitHubBaseRefreshSchema,
  GitHubPullRequestInspectSchema,
  GitHubPublicationActionSchema,
  GitHubPublicationEditSchema,
  GitHubPublicationEvidenceSchema,
  GitHubPublicationTitleSchema,
} from "@openclaw/gateway-protocol";
import { Type } from "typebox";

export const publicationOperatorActions = GitHubPublicationActionSchema.properties.action.anyOf.map(
  (action) => action.const,
);
export const publicationWorkspaceActions = [
  "publish",
  "inspect_pr",
  "prepare_pr",
  "refresh_base",
  "edit",
  "ready",
  "request_review",
  "upload_evidence",
];

export const githubPublishToolDefinition = {
  name: "github_publish",
  parameters: Type.Object(
    {
      pullRequestUrl: Type.Optional(GitHubPullRequestInspectSchema.properties.pullRequestUrl),
      ...GitHubBaseRefreshSchema.properties,
      ...GitHubPublicationEditSchema.properties,
      evidence: Type.Optional(GitHubPublicationEvidenceSchema),
      action: Type.Optional(Type.Enum(publicationWorkspaceActions, { type: "string" })),
      title: Type.Optional(GitHubPublicationTitleSchema),
      body: GitHubPublicationEditSchema.properties.body,
      draft: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
};
