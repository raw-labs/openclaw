import path from "node:path";
import { installMockGateway } from "./control-ui-e2e.ts";

export const GITHUB_REPOSITORY_PLUGIN = {
  pluginId: "github-repositories",
  rootDir: path.resolve(import.meta.dirname, "../../../extensions/github-repositories"),
  source: "browser/index.tsx",
};

/** Repository scenarios load the actual plugin bundle; an explicit empty list proves withdrawal. */
export function installRepositoryGateway(
  page: Parameters<typeof installMockGateway>[0],
  scenario: Parameters<typeof installMockGateway>[1] = {},
) {
  return installMockGateway(page, { nativePlugins: [GITHUB_REPOSITORY_PLUGIN], ...scenario });
}
