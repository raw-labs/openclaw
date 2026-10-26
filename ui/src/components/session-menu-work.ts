import type { WorktreeRecord } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { isNativeLocalGateway } from "../app/native-editor-locality.runtime.ts";

// Shared by the app sidebar and the Sessions page: both hosts resolve the
// same local checkout path when opening the
// session context menu, after the menu is already visible.
type SessionMenuWorkParams = {
  client: Pick<GatewayBrowserClient, "request">;
  worktreeId?: string;
  execNode?: string;
};

type SessionMenuWorkResult = {
  worktreePath: string | null;
};

async function loadWorktreePath(params: SessionMenuWorkParams): Promise<string | null> {
  const worktreeId = params.worktreeId;
  if (!worktreeId || params.execNode) {
    return null;
  }
  if (!isNativeLocalGateway()) {
    return null;
  }
  try {
    const result = await params.client.request<{ worktrees: WorktreeRecord[] }>(
      "worktrees.list",
      {},
    );
    const record = result.worktrees.find(
      (candidate) => candidate.id === worktreeId && candidate.removedAt === undefined,
    );
    return record?.path ?? null;
  } catch {
    return null;
  }
}

export async function fetchSessionMenuWork(
  params: SessionMenuWorkParams,
): Promise<SessionMenuWorkResult> {
  return { worktreePath: await loadWorktreePath(params) };
}
