import { normalizeCloudRepo } from "../config/cloud-worker-project-profiles.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RepositorySources } from "./repository-sources.js";

/** Operator repository selection shared by the picker and prepared pool. */
export function configuredDefaultRepository(
  config: OpenClawConfig | null = getRuntimeConfigSnapshot(),
  sources?: Pick<RepositorySources, "resolve">,
) {
  const selected = config?.gateway?.projects?.defaultRepository;
  if (!selected) {
    return undefined;
  }
  let parsed: ReturnType<RepositorySources["resolve"]>;
  try {
    if (!sources) {
      return undefined;
    }
    parsed = sources.resolve(selected.url);
    parsed.assertCurrent();
  } catch {
    return undefined;
  }
  const key = normalizeCloudRepo(parsed.url);
  const identity = key ? key.slice(key.indexOf("/") + 1) : parsed.name;
  const profileId = key ? config?.cloudWorkers?.projectProfiles?.[key] : undefined;
  return {
    identity,
    url: parsed.url,
    ...(selected.ref ? { ref: selected.ref } : {}),
    ...(profileId ? { profileId } : {}),
  };
}
