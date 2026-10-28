import type { HealthCheck, OpenClawConfig } from "openclaw/plugin-sdk/health";
import { describe, expect, it } from "vitest";
import { registerDoctorHealthChecks } from "./api.js";

function projectCheck() {
  const checks = new Map<string, HealthCheck>();
  registerDoctorHealthChecks({
    getHealthCheck: (id) => checks.get(id),
    registerHealthCheck: (check) => {
      checks.set(check.id, check);
    },
  });
  const check = checks.get("github-repositories/project-access");
  if (!check) {
    throw new Error("GitHub project check was not registered");
  }
  return check;
}

describe("GitHub project credential advice", () => {
  it.each<{ cfg: OpenClawConfig; env: NodeJS.ProcessEnv; expected: boolean }>([
    { cfg: {}, env: {}, expected: true },
    { cfg: {}, env: { GH_TOKEN: "configured" }, expected: false },
    {
      cfg: {
        plugins: {
          entries: {
            "github-repositories": {
              config: {
                service: {
                  token: { source: "store", provider: "default", id: "CONTROL_UI_GITHUB" },
                },
              },
            },
          },
        },
      },
      env: {},
      expected: false,
    },
  ])(
    "reports missing credentials without resolving SecretRefs: %#",
    async ({ cfg, env, expected }) => {
      const findings = await projectCheck().detect({
        mode: "doctor",
        cfg,
        env,
        runtime: { log() {}, error() {}, exit() {} },
      });
      if (expected) {
        expect(findings).toEqual([
          expect.objectContaining({
            checkId: "github-repositories/project-access",
            message: expect.stringContaining(
              "config.service.host matching plugins.entries.github-repositories.config.host",
            ),
          }),
        ]);
      } else {
        expect(findings).toEqual([]);
      }
    },
  );
});
