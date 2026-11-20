export type PluginHookSessionStartEvent = {
  sessionId: string;
  sessionKey?: string;
  resumedFrom?: string;
};

export type PluginHookSessionEndReason =
  | "new"
  | "reset"
  | "idle"
  | "daily"
  | "compaction"
  | "deleted"
  | "shutdown"
  | "restart"
  | "unknown";

export type PluginHookSessionEndEvent = {
  sessionId: string;
  sessionKey?: string;
  /** Lifecycle revision of the ended generation, when available from the committing owner. */
  lifecycleRevision?: string;
  messageCount: number;
  durationMs?: number;
  reason?: PluginHookSessionEndReason;
  sessionFile?: string;
  transcriptArchived?: boolean;
  nextSessionId?: string;
  nextSessionKey?: string;
};
