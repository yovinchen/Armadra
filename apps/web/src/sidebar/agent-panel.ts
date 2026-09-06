/**
 * 铃铛面板的纯逻辑（§27）。
 *
 * 分区与状态语义一律复用 `agent/sessions` 的分桶（与看板行下面那段 Agent
 * 列表同源），这里只定两件事：分区在面板里的先后，以及每个分区用哪种胶囊。
 */
import {
  groupSessionsByStatus,
  type SessionBucket,
  type SessionRow,
  type SessionSection,
} from "../agent/sessions";
import type { StatusTone } from "../ui/status-pill";

/** 面板里的分区顺序：先要人管的，再跑着的，然后没看过的，最后安静的。 */
export const AGENT_BUCKET_ORDER: readonly SessionBucket[] = [
  "attention",
  "working",
  "unread",
  "idle",
  "unknown",
];

/** 分区 → 胶囊色。`unknown`（没有 Agent 状态的终端）与空闲同色。 */
export function bucketTone(bucket: SessionBucket): StatusTone {
  switch (bucket) {
    case "attention":
      return "attention";
    case "working":
      return "working";
    case "unread":
      return "unread";
    default:
      return "idle";
  }
}

/** 当前工作空间里还活着的会话 → 按 `AGENT_BUCKET_ORDER` 排好的分区。 */
export function agentSections(
  rows: readonly SessionRow[],
): SessionSection[] {
  const alive = rows.filter((row) => row.alive);
  return groupSessionsByStatus(alive).sort(
    (a, b) =>
      AGENT_BUCKET_ORDER.indexOf(a.bucket) -
      AGENT_BUCKET_ORDER.indexOf(b.bucket),
  );
}
