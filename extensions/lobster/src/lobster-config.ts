import { createHash } from "node:crypto";

export type LobsterConfig = {
  directory?: string;
  backend?: "files" | "sqlite";
  history: boolean;
};

export function parseLobsterConfig(value: unknown): LobsterConfig {
  if (value === undefined || value === null) {
    return { history: false };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Lobster config must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!["directory", "backend", "history"].includes(key)) {
      throw new Error(`Unknown Lobster config key: ${key}`);
    }
  }
  const { directory, backend, history } = value as Record<string, unknown>;
  if (directory !== undefined && (typeof directory !== "string" || !directory.trim())) {
    throw new Error("Lobster directory must be a nonempty string");
  }
  if (backend !== undefined && backend !== "files" && backend !== "sqlite") {
    throw new Error("Lobster backend must be files or sqlite");
  }
  if (history !== undefined && typeof history !== "boolean") {
    throw new Error("Lobster history must be a boolean");
  }
  return {
    ...(typeof directory === "string" ? { directory } : {}),
    ...(backend ? { backend } : {}),
    history: history ?? false,
  };
}

/** The logical conversation survives Gateway restarts and /new; its session UUID does not. */
export function resolveLobsterCallerId(context: {
  agentId?: string;
  sessionKey?: string;
}): string | undefined {
  if (!context.agentId || !context.sessionKey) {
    return undefined;
  }
  return createHash("sha256")
    .update(JSON.stringify([context.agentId, context.sessionKey]))
    .digest("hex");
}
