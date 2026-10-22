import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  RepositoryWorkerProjectSchema,
  type RepositoryWorkerProjectSnapshot,
} from "./repository-project-source.schema.js";

/** Repository facts persist; current visibility and access remain admission checks. */
export function readRepositoryWorkerProjectSnapshot(
  value: unknown,
): RepositoryWorkerProjectSnapshot | undefined {
  if (!isRecord(value) || value.source === undefined) {
    return undefined;
  }
  const parsed = RepositoryWorkerProjectSchema.safeParse(value);
  const source = parsed.success ? parsed.data.source : undefined;
  const url = source && URL.canParse(source.url) ? new URL(source.url) : undefined;
  if (
    Object.keys(value).some(
      (key) => !["key", "baseCommit", "source", "preparation"].includes(key),
    ) ||
    !parsed.success ||
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== parsed.data.source.url
  ) {
    throw new Error("Worker environment has an invalid repository preparation snapshot");
  }
  return parsed.data;
}
