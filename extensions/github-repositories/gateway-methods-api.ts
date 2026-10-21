// Metadata remains cheap; plugin activation owns implementation loading.
const CONTROL_PLANE_WRITE = { controlPlaneWrite: true } as const;
const SIDECAR_CONTROL_PLANE_WRITE = { startup: true, controlPlaneWrite: true } as const;
export const repositoryGatewayMethods = [
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
] as const;
