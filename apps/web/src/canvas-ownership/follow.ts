import { useEffect } from "react";

import {
  canvasEventCursor,
  resetCanvasEventCursor,
  resolveCanvasHostClient,
} from "./gateway";
import { canvasOwnershipStatus } from "./store";

/**
 * 按 sequence 续订 Host 的画布事件（H01 §3.3）。
 *
 * Host 的事件与实体同事务写出，编号是一条单调的 durable sequence，所以「我看到
 * 哪儿了」就是一个数。这里保存那个数，每轮从它之后取，取到的才是真正错过的
 * 改动——不是把整段历史当成刚发生的事重放一遍。
 *
 * 三种回答是三件不同的事，不能都用「空页」表示：
 *  - `ok`：把游标推到 `nextCursor`。没有事件就什么都不做。
 *  - `snapshotRequired`：游标掉到保留下限以下。先取快照拿到它一致的那个
 *    序号，再从那里续——不能假装从下限开始就没漏。
 *  - `cursorAhead`：游标超过了这台 Host 的水位。换了一台 Host 或库被恢复过；
 *    把游标退回水位会把已经应用过的改动悄悄丢掉，所以这里**停止跟随**。
 *
 * Runtime 在写时这里什么都不做：那条路上有工作空间事件 WebSocket。
 */
export const CANVAS_EVENT_POLL_MS = 3_000;

/** 一轮跟随的结果。每一档都是真状态，没有「大概没事」。 */
export type CanvasFollowOutcome =
  /** 不是 Host 在写，或这个工作空间还没读过文档：没有可续的位置。 */
  | "unavailable"
  /** 续上了，但没有新事件。 */
  | "idle"
  /** 有新事件，游标已前进。 */
  | "changed"
  /** 游标过旧，已按快照重置；调用方应当重读。 */
  | "resnapshot"
  /** 游标超出水位：停止跟随，不回退。 */
  | "diverged"
  /** 这一轮没问到（离线、会话过期）。下一轮再试，不改游标。 */
  | "unreachable";

/**
 * 跑一轮。**不改画布内容**：它只回答「有没有别处的改动」，由调用方决定重读。
 * 这里不做合并——本地未落盘的编辑不该被一次轮询覆盖掉。
 */
export async function pollCanvasEvents(
  workspaceId: string,
  limit = 200,
): Promise<CanvasFollowOutcome> {
  if (canvasOwnershipStatus() !== "host") return "unavailable";
  const cursor = canvasEventCursor(workspaceId);
  if (cursor === null) return "unavailable";
  let client;
  try {
    client = await resolveCanvasHostClient(workspaceId, false);
  } catch {
    return "unreachable";
  }
  try {
    const feed = await client.subscribeEvents(cursor, limit);
    if (feed.status === "cursorAhead") return "diverged";
    if (feed.status === "snapshotRequired") {
      // 只要那个一致的序号；快照的内容由调用方按正常读取路径重取，
      // 免得同一份文档被两条路各解一遍。
      const snapshot = await client.getSnapshot("", 1);
      resetCanvasEventCursor(workspaceId, snapshot.sequence);
      return "resnapshot";
    }
    if (feed.events.length === 0) return "idle";
    resetCanvasEventCursor(workspaceId, feed.nextCursor);
    return "changed";
  } catch {
    // 问不到就不动游标：把它当成「没有新事件」会在恢复之后跳过这段。
    return "unreachable";
  }
}

/**
 * 挂上轮询。`onChanged` 在别处改过画布时触发一次，调用方通常用它让文档查询
 * 失效；`diverged` 之后停表，因为继续问只会一直得到同一个答案。
 */
export function followCanvasEvents(
  workspaceId: string,
  onChanged: (outcome: CanvasFollowOutcome) => void,
  intervalMs = CANVAS_EVENT_POLL_MS,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    timer = null;
    const outcome = await pollCanvasEvents(workspaceId);
    if (stopped) return;
    if (outcome === "changed" || outcome === "resnapshot") onChanged(outcome);
    if (outcome === "diverged") return;
    timer = setTimeout(() => void tick(), intervalMs);
  };
  timer = setTimeout(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** 画布视图挂一次。Runtime 在写时是空操作。 */
export function useCanvasEventFollower(
  workspaceId: string | null,
  onChanged: () => void,
): void {
  useEffect(() => {
    if (!workspaceId) return;
    return followCanvasEvents(workspaceId, onChanged);
  }, [workspaceId, onChanged]);
}
