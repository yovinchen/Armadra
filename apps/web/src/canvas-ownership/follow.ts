import { useEffect } from "react";

import {
  connectCanvasEventStream,
  type CanvasEventSource,
  type CanvasEventStreamHandle,
} from "../host/event-stream";

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
 *
 * 从 B0b 起这条轮询**是后备**，不是主路：Host 有事件流时由流推送，轮询只在
 * 流不可用或正在重连时接手。间隔因此从 3 秒放宽到 10 秒——它要覆盖的是
 * 「流断了这一段」，不再是每一次改动的可见延迟。
 */
export const CANVAS_EVENT_POLL_MS = 10_000;

/**
 * 一轮最多追多少页。有上限是因为这是一个定时器里的循环：落后很多时先追一段，
 * 剩下的下一轮继续，而不是把界面卡在一次无界的追赶里。
 */
const MAX_CATCH_UP_PAGES = 10;

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
  let position = cursor;
  let changed = false;
  try {
    // 一页里可能一条本工作空间的事件都没有——同一台 Host 上别的工作空间在
    // 忙的时候就是这样。这种页仍然要把游标推到 `nextCursor`：那一段确实已经
    // 看过了，停在原地会让游标永远追不上，跟随器一直重扫同一段历史。
    for (let page = 0; page < MAX_CATCH_UP_PAGES; page += 1) {
      const feed = await client.subscribeEvents(position, limit);
      if (feed.status === "cursorAhead") return "diverged";
      if (feed.status === "snapshotRequired") {
        // 只要那个一致的序号；快照的内容由调用方按正常读取路径重取，
        // 免得同一份文档被两条路各解一遍。
        const snapshot = await client.getSnapshot("", 1);
        resetCanvasEventCursor(workspaceId, snapshot.sequence);
        return "resnapshot";
      }
      changed = changed || feed.events.length > 0;
      position = feed.nextCursor;
      resetCanvasEventCursor(workspaceId, position);
      if (!feed.hasMore) break;
    }
    return changed ? "changed" : "idle";
  } catch {
    // 问不到就不动游标：把它当成「没有新事件」会在恢复之后跳过这段。
    // 已经推进过的页不回滚——那些确实看过了。
    return changed ? "changed" : "unreachable";
  }
}

/**
 * 挂上跟随：优先接 Host 的事件流，流不可用时用轮询顶上。
 *
 * 两条路共用同一个游标，所以来回切换不会漏也不会重：流推过的那一段轮询不会
 * 再扫一遍，轮询追过的那一段流也会从同一个位置往后订。同一时刻只有一条在
 * 跑——流连通时**不发轮询请求**，这正是这一批要去掉的那 3 秒一次。
 *
 * `onChanged` 在别处改过画布时触发一次，调用方通常用它让文档查询失效；
 * `diverged` 之后两条路一起停表，因为继续问只会一直得到同一个答案。
 */
export function followCanvasEvents(
  workspaceId: string,
  onChanged: (outcome: CanvasFollowOutcome) => void,
  intervalMs = CANVAS_EVENT_POLL_MS,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stream: CanvasEventStreamHandle | null = null;
  let source: CanvasEventSource = "polling";

  const stopStream = () => {
    stream?.stop();
    stream = null;
    source = "polling";
  };

  // 流要有个可续的位置才开得起来：游标为空表示这个工作空间还没读过文档，
  // 从 0 订会把整段历史当成刚发生的改动重放一遍。所以先让轮询把游标建立
  // 起来，之后每一轮再尝试接流。
  const ensureStream = () => {
    if (stopped || stream || canvasOwnershipStatus() !== "host") return;
    const cursor = canvasEventCursor(workspaceId);
    if (cursor === null) return;
    stream = connectCanvasEventStream(workspaceId, cursor, {
      onChanged: () => {
        if (!stopped) onChanged("changed");
      },
      onDiverged: () => {
        stopped = true;
        stopStream();
        if (timer) clearTimeout(timer);
        timer = null;
      },
      onSource: (next) => {
        source = next;
      },
    });
  };

  const tick = async () => {
    timer = null;
    ensureStream();
    // 流在推的时候不问：这一段它已经负责了，再轮询一次只是重复流量。
    if (source !== "stream") {
      const outcome = await pollCanvasEvents(workspaceId);
      if (stopped) return;
      if (outcome === "changed" || outcome === "resnapshot") onChanged(outcome);
      if (outcome === "diverged") {
        stopStream();
        return;
      }
      // 轮询刚把游标建立起来，这一轮就可以接流，不必再等一个间隔。
      ensureStream();
    }
    if (stopped) return;
    timer = setTimeout(() => void tick(), intervalMs);
  };

  ensureStream();
  timer = setTimeout(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    stopStream();
    if (timer) clearTimeout(timer);
    timer = null;
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
