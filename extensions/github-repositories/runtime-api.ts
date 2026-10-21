import { toolsGitHubHandlers } from "./src/tools-github.js";
import { usersGitHubHandlers } from "./src/users-github.js";
export const repositoryHandlers = { ...toolsGitHubHandlers, ...usersGitHubHandlers };
