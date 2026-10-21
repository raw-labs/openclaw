import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";

export const testProfile = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Test Person",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: ["test@example.com"],
  githubIdentity: null,
  hasAvatar: false,
};
export const githubAvatarUrl = "https://avatars.githubusercontent.com/u/583231?v=4";
export const linkedGitHubProfile = {
  ...testProfile,
  githubIdentity: {
    login: "octocat",
    profileUrl: "https://github.com/octocat",
    avatarUrl: githubAvatarUrl,
  },
};
export const testPresenceUsers: NonNullable<ControlUiMockGatewayScenario["presenceUsers"]> = [
  {
    self: true,
    id: testProfile.id,
    name: testProfile.displayName,
    email: testProfile.emails[0],
    avatarUrl: `/api/users/${testProfile.id}/avatar?v=${testProfile.updatedAt}`,
  },
];
