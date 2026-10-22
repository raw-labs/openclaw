import type { LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";
import {
  findLegacyToolNamePaths,
  GITHUB_READER_TOOL_GROUP_MIGRATION,
  type LegacyToolNameMigration,
  IMAGE_INSPECTION_TOOL_NAME_MIGRATION,
  migrateLegacyToolNamePolicies,
  TASK_SUGGESTION_TOOL_NAME_MIGRATION,
} from "./legacy-tool-name-migration.js";
import { TOOL_POLICY_ROOTS } from "./legacy-tool-policy-scopes.js";

const TOOL_NAME_MIGRATIONS: { id: string; migration: LegacyToolNameMigration }[] = [
  {
    id: "tools.suggest-task-name",
    migration: TASK_SUGGESTION_TOOL_NAME_MIGRATION,
  },
  {
    id: "tools.view-image-name",
    migration: IMAGE_INSPECTION_TOOL_NAME_MIGRATION,
  },
  { id: "tools.github-reader-group", migration: GITHUB_READER_TOOL_GROUP_MIGRATION },
];

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_TOOL_NAMES =
  TOOL_NAME_MIGRATIONS.map<LegacyConfigMigrationSpec>((migration) => ({
    id: migration.id,
    legacyRules: TOOL_POLICY_ROOTS.map((root) => ({
      path: [root],
      message: `Tool policies still rely on legacy ${migration.migration.legacyName} coverage; run "openclaw doctor --fix" to preserve equivalent ${[migration.migration.canonicalName, ...(migration.migration.additionalCanonicalNames ?? [])].join(", ")} access.`,
      match: (value) => findLegacyToolNamePaths(value, migration.migration, [root]).length > 0,
    })),
    apply: (raw, changes) => {
      const paths = TOOL_POLICY_ROOTS.flatMap((root) =>
        migrateLegacyToolNamePolicies(raw[root], migration.migration, [root]),
      );
      if (paths.length === 0) {
        return;
      }
      changes.push(
        `Migrated legacy ${migration.migration.legacyName} policy coverage to ${[migration.migration.canonicalName, ...(migration.migration.additionalCanonicalNames ?? [])].join(", ")} in ${paths.join(", ")}.`,
      );
    },
  }));
