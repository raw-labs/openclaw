import { controlUiGitHubHandlers } from "./src/control-ui-github.js";
import { repositoryProjectHandlers } from "./src/projects.js";
import { toolsGitHubReadHandlers } from "./src/tools-github-read.js";
import { toolsGitHubHandlers } from "./src/tools-github.js";
import { usersGitHubHandlers } from "./src/users-github.js";
export { repositoryProjectHandlers };

export const repositoryHandlers = {
  ...toolsGitHubHandlers,
  ...toolsGitHubReadHandlers,
  ...controlUiGitHubHandlers,
  ...usersGitHubHandlers,
  ...repositoryProjectHandlers,
};

export { controlUiGitHubHandlers };
