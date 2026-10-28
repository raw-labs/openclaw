import { controlUiGitHubHandlers } from "./src/control-ui-github.js";
import { repositoryProjectHandlers } from "./src/projects.js";
import { toolsGitHubHandlers } from "./src/tools-github.js";
import { usersGitHubHandlers } from "./src/users-github.js";
export { repositoryProjectHandlers };

export const repositoryHandlers = {
  ...toolsGitHubHandlers,
  ...controlUiGitHubHandlers,
  ...usersGitHubHandlers,
  ...repositoryProjectHandlers,
};

export { controlUiGitHubHandlers };
