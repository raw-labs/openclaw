import {
  UserGitHubConnectionAuthorityChangedError,
  prepareUserGitHubConnection,
} from "openclaw/plugin-sdk/repository-oauth-host";
import type { PersonalGitHubAction } from "./personal-oauth-api.js";
import {
  rejectGitHubPublicationSelection,
  type GitHubPublicationPreparation,
} from "./publication-failure-api.js";
import { preparePersonalGitHubPublicationIdentity } from "./tool-identity-api.js";

type Selection = { generation: string; account: { accountId: number; login: string } };
export async function bindPersonalGitHubPublicationSelection(
  action: PersonalGitHubAction,
  selected: Selection,
  preparation?: GitHubPublicationPreparation,
) {
  const rejectRevokedConnection = (error: unknown): never => {
    if (!(error instanceof UserGitHubConnectionAuthorityChangedError)) {
      throw error;
    }
    rejectGitHubPublicationSelection(
      "My GitHub identity changed; review the current account before publishing again.",
      preparation,
    );
  };
  let prepared = await prepareUserGitHubConnection(action.owner).catch(rejectRevokedConnection);
  const assertCurrent = () => {
    action.assertCurrent();
    let record: ReturnType<typeof prepared.read>;
    try {
      record = prepared.read();
    } catch (error) {
      rejectRevokedConnection(error);
    }
    if (
      record?.generation !== selected.generation ||
      record.selection.kind !== "connected" ||
      record.selection.accountId !== selected.account.accountId ||
      record.selection.login.toLowerCase() !== selected.account.login.toLowerCase()
    ) {
      rejectGitHubPublicationSelection(
        "My GitHub identity changed; review the current account before publishing again.",
        preparation,
      );
    }
    return record.selection;
  };
  const initial = assertCurrent();
  return {
    owner: action.owner,
    profileId: initial.profileId,
    accountId: initial.accountId,
    assertCurrent,
    async refresh() {
      prepared = await prepareUserGitHubConnection(action.owner).catch(rejectRevokedConnection);
      assertCurrent();
    },
  };
}

export async function preparePersonalGitHubPublicationSelection(
  bound: Awaited<ReturnType<typeof bindPersonalGitHubPublicationSelection>>,
  assertWorkspace: () => void,
  refreshPersonal: (owner: string) => Promise<void>,
) {
  const assertCurrent = () => {
    bound.assertCurrent();
    assertWorkspace();
  };
  assertCurrent();
  try {
    await refreshPersonal(bound.owner);
    await bound.refresh();
  } catch {
    await bound.refresh();
    assertCurrent();
    throw new Error(
      "My GitHub credentials are unavailable; reconnect My GitHub before publishing.",
    );
  }
  assertCurrent();
  return await preparePersonalGitHubPublicationIdentity({
    profileId: bound.profileId,
    accountId: bound.accountId,
    assertCurrent,
  });
}
