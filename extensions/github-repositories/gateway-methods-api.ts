// Metadata remains cheap; plugin activation owns implementation loading.
const CONTROL_PLANE_WRITE = { controlPlaneWrite: true } as const;
const SIDECAR_CONTROL_PLANE_WRITE = { startup: true, controlPlaneWrite: true } as const;
const UNADVERTISED = { advertise: false } as const;
export const repositoryGatewayMethods = [
  ["controlUi.githubPreview", "control-ui", "operator.read", "<=2026.7"],
  ["controlUi.githubDetail", "control-ui", "operator.read", "2026.9"],
  ["controlUi.sessionPullRequests.subscribe", "control-ui", "operator.read", "2026.7"],
  ["controlUi.sessionPullRequests.checks", "control-ui", "operator.read", "2026.9"],
  ["tools.github.read", "tools-github", "operator.sessions.read", "2026.10", UNADVERTISED],
  ["tools.github.search", "tools-github", "operator.sessions.read", "2026.10", UNADVERTISED],
  ["tools.github.status", "tools-github", "operator.read", "2026.8"],
  ["tools.github.configure", "tools-github", "operator.admin", "2026.8", CONTROL_PLANE_WRITE],
  ["tools.github.authorize.start", "tools-github", "operator.admin", "2026.8", CONTROL_PLANE_WRITE],
  ["tools.github.authorize.poll", "tools-github", "operator.admin", "2026.8", CONTROL_PLANE_WRITE],
  [
    "tools.github.authorize.cancel",
    "tools-github",
    "operator.admin",
    "2026.8",
    CONTROL_PLANE_WRITE,
  ],
  ["users.github.status", "users", "operator.read", "2026.8", { startup: true }],
  ["users.github.authorize.start", "users", "operator.read", "2026.8", SIDECAR_CONTROL_PLANE_WRITE],
  ["users.github.authorize.poll", "users", "operator.read", "2026.8", SIDECAR_CONTROL_PLANE_WRITE],
  [
    "users.github.authorize.cancel",
    "users",
    "operator.read",
    "2026.8",
    SIDECAR_CONTROL_PLANE_WRITE,
  ],
  ["users.github.disconnect", "users", "operator.read", "2026.8", SIDECAR_CONTROL_PLANE_WRITE],
  [
    "projects.searchRemote",
    "projects",
    "operator.read",
    "2026.8",
    { description: "Search GitHub repositories that can be cloned as managed projects." },
  ],
  ["projects.add", "projects", "operator.write", "2026.8", CONTROL_PLANE_WRITE],
] as const;
