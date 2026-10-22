import { repositoryProjectHandlers } from "./src/projects.js";
import { toolsGitHubHandlers } from "./src/tools-github.js";
import { usersGitHubHandlers } from "./src/users-github.js";
export { repositoryProjectHandlers };

export const repositoryHandlers = {
  ...toolsGitHubHandlers,
  ...usersGitHubHandlers,
  ...repositoryProjectHandlers,
};
