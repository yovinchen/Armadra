import { runtimeApi } from "@/api/client";

/**
 * 权限直答的软引用。
 *
 * 写文件已经进 `runtimeApi.writeFile`，这里只剩 `answerApproval`：
 * 它的 Runtime 端归另一个 agent，所以保留「client 有就用、没有退回裸
 * fetch」这一层，等那边落定后本文件可以整体删掉。
 */

const RUNTIME_BASE: string =
  (import.meta.env.VITE_RUNTIME_URL as string | undefined) ??
  "http://127.0.0.1:43120";

interface OptionalRuntimeApi {
  answerApproval?: (
    pendingId: string,
    decision: "allow" | "deny",
  ) => Promise<unknown>;
}

const optional = runtimeApi as unknown as OptionalRuntimeApi;

/** 权限直答：`POST /api/approvals/{pendingId}/answer`（§5.5）。 */
export async function answerApproval(
  pendingId: string,
  decision: "allow" | "deny",
): Promise<void> {
  if (typeof optional.answerApproval === "function") {
    await optional.answerApproval(pendingId, decision);
    return;
  }
  const response = await fetch(
    `${RUNTIME_BASE}/api/approvals/${encodeURIComponent(pendingId)}/answer`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    },
  );
  if (!response.ok) {
    throw new Error(`approval answer failed (${response.status})`);
  }
}
