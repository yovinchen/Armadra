import type { DatabaseSync } from "node:sqlite";

import type { WorkspaceEvent } from "../bus";

/**
 * 事件 outbox —— 断线之后把漏掉的那一段补回去。
 *
 * R1b 建的扇出是纯内存的，因为同进程里「谁在听」是一次函数调用的事；它留下的
 * 唯一缺口在交接报告里写明了：**断线续订需要 outbox 表 + `publish` 钩子 + 升级
 * 时读 `?cursor=`**。这个文件就是那三样里的前两样。
 *
 * ## 和 Go Host 的关系
 *
 * `apps/host/internal/eventstream/catchup.go` 的三个状态原样保留，因为它们是
 * 三个答案，不是同一个答案的深浅：
 *
 *   * `ok` —— 这些帧补上，然后从 `nextCursor` 继续；
 *   * `snapshotRequired` —— 游标低于保留下限，没有诚实的一页可发，客户端得重新
 *     拉一次快照（对页面来说就是重新走一遍 REST 读）；
 *   * `cursorAhead` —— 客户端手里的序号这个 core 从没发过。把它倒回水位会悄悄
 *     丢掉它已经应用过的改动，所以这也是拒绝，不是修正。
 *
 * ## 写入与业务同事务
 *
 * {@link appendEvent} 只发 `INSERT`，不自己开事务。调用它的业务写入要么已经在
 * 一个事务里（那它就搭同一班车），要么是一次单语句写入（那它自己就是事务）。
 * 这是 outbox 模式唯一重要的那条规矩：事件和它描述的那次写入必须一起成功或者
 * 一起失败，否则页面会收到一条描述着并不存在的改动的帧。
 *
 * ## 游标不在帧里
 *
 * 帧的形状是契约：21 个 `type` 字符串，字段和 `type` 平铺，`workspaceEventSchema`
 * 逐字段解析。加一个 `seq` 是破坏性改动——`packages/shared` 要跟着改，而
 * `apps/web/src/api/events.ts` 这一批不许动。
 *
 * 所以游标走带外，而且**只发给要它的人**：带了 `?cursor=` 的订阅在每一帧之后多
 * 收一条控制帧（`{"type":"cursor",…}`，见
 * {@link import("./stream").cursorFrame}）；页面不带游标，于是页面收到的仍然只
 * 有那 21 个契约事件，一帧不多一帧不少。拒绝续订的两个状态没有 socket 可说话，
 * 写在升级的状态行上：`409 SNAPSHOT_REQUIRED` / `409 CURSOR_AHEAD`。
 */

/** 一条 outbox 记录，读出来就是当初发出去的那一帧。 */
export interface OutboxRecord {
  readonly seq: number;
  readonly workspaceId: string;
  /** 广播时序列化的那一行 JSON，逐字节原样。 */
  readonly frame: string;
}

export type CursorStatus = "ok" | "snapshotRequired" | "cursorAhead";

export interface CatchUpPage {
  readonly status: CursorStatus;
  /** 补发的帧，最旧在前。非 `ok` 时为空。 */
  readonly records: readonly OutboxRecord[];
  /** 客户端下一次该带的游标。非 `ok` 时是 0。 */
  readonly nextCursor: number;
  /** 保留下限：比它小的游标已经没有历史了。 */
  readonly floor: number;
  /** 水位：这个 core 发过的最大序号。 */
  readonly watermark: number;
  readonly hasMore: boolean;
}

/** 一页最多补发多少帧。和 `eventstream` 的 `MaxPageEvents` 同一个量级。 */
export const MAX_CATCH_UP_EVENTS = 512;

/** outbox 最多留多少条。超出的那一段在写入时随手裁掉，不另起清理任务。 */
export const RETAINED_EVENTS = 5_000;

/** 这个库有没有 outbox 表。没过 0018 的库照旧只有实时扇出。 */
export function outboxReady(database: DatabaseSync): boolean {
  try {
    const row = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'events'",
      )
      .get();
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * 把一帧记进 outbox，返回它的序号。
 *
 * 失败不抛给业务：一次存下来的看板文档仍然是存下来了，哪怕没人能把这条广播补
 * 发第二次。返回 0 表示这一帧没有进 outbox。
 */
export function appendEvent(
  database: DatabaseSync,
  workspaceId: string,
  event: WorkspaceEvent,
  frame: string,
  atMs: number = Date.now(),
): number {
  const result = database
    .prepare(
      "INSERT INTO events (workspace_id, type, payload_json, at_ms) VALUES (?, ?, ?, ?)",
    )
    .run(workspaceId, event.type, frame, Math.max(1, Math.trunc(atMs)));
  const seq = Number(result.lastInsertRowid);
  bumpWatermark(database, seq);
  return seq;
}

/**
 * 水位与下限记在 `store_meta`，列是 0015 照 schemaV1 抄下来的那两列。
 *
 * `store_meta` 可能还没有那一行（这个库还没配过对），这时候水位就是 outbox 自己
 * 的最大序号——读的时候会回到这一点，所以这里写不进去不是错误。
 */
function bumpWatermark(database: DatabaseSync, seq: number): void {
  try {
    database
      .prepare(
        "UPDATE store_meta SET last_sequence = ? WHERE singleton = 1 AND last_sequence < ?",
      )
      .run(seq, seq);
  } catch {
    // `store_meta` 不在、或者这一行还没建：水位从 outbox 自己读得出来。
  }
}

/** 读保留下限与水位。两个都从库里读，不缓存——core 只有一个写者，但没有第二份真相。 */
export function watermark(database: DatabaseSync): {
  readonly floor: number;
  readonly watermark: number;
} {
  let floor = 0;
  let last = 0;
  try {
    const meta = database
      .prepare(
        "SELECT event_floor AS floor, last_sequence AS last FROM store_meta WHERE singleton = 1",
      )
      .get() as { floor?: unknown; last?: unknown } | undefined;
    floor = Number(meta?.floor ?? 0);
    last = Number(meta?.last ?? 0);
  } catch {
    floor = 0;
    last = 0;
  }
  const bounds = database
    .prepare("SELECT min(seq) AS low, max(seq) AS high FROM events")
    .get() as { low?: unknown; high?: unknown } | undefined;
  const low = bounds?.low === null ? 0 : Number(bounds?.low ?? 0);
  const high = bounds?.high === null ? 0 : Number(bounds?.high ?? 0);
  // 表里最旧的那条在下限之上时，下限就是「它前面那一条」——裁剪走过的那一段。
  // 反过来，`store_meta` 说的下限比表里第一条还高，说明裁剪提交了而 meta 没跟上，
  // 取大的那个：多说「这段没了」比谎称它还在安全。
  return {
    floor: Math.max(floor, low === 0 ? 0 : low - 1),
    watermark: Math.max(last, high),
  };
}

/**
 * 从 `cursor` 之后读一页。
 *
 * 和 Host 一样，「补发」和「推送」是同一次读：还有历史就 `hasMore`，读到水位就
 * 进入推送。这里的区别只是推送那一半由内存扇出接手，所以调用方读完一页就把
 * socket 挂上去。
 */
export function catchUp(
  database: DatabaseSync,
  workspaceId: string,
  cursor: number,
  limit: number = MAX_CATCH_UP_EVENTS,
): CatchUpPage {
  const bounds = watermark(database);
  const empty = {
    records: [] as readonly OutboxRecord[],
    nextCursor: 0,
    floor: bounds.floor,
    watermark: bounds.watermark,
    hasMore: false,
  };
  if (cursor < bounds.floor) {
    return { status: "snapshotRequired", ...empty };
  }
  if (cursor > bounds.watermark) {
    return { status: "cursorAhead", ...empty };
  }
  const page = Math.max(1, Math.min(limit, MAX_CATCH_UP_EVENTS));
  const rows = database
    .prepare(
      "SELECT seq, workspace_id AS workspaceId, payload_json AS frame FROM events " +
        "WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    )
    .all(workspaceId, cursor, page + 1) as {
    seq: number;
    workspaceId: string;
    frame: string;
  }[];
  const hasMore = rows.length > page;
  const records = rows.slice(0, page).map((row) => ({
    seq: Number(row.seq),
    workspaceId: row.workspaceId,
    frame: row.frame,
  }));
  // 一页发完之后的游标：还有历史就停在最后一条上，否则直接跳到水位。跳过去是
  // 关键——被这个工作空间的过滤器挡掉的那些序号也要算走过了，不然一条窄订阅会
  // 永远在同一段历史上来回扫。
  const nextCursor = hasMore
    ? (records[records.length - 1]?.seq ?? cursor)
    : bounds.watermark;
  return {
    status: "ok",
    records,
    nextCursor,
    floor: bounds.floor,
    watermark: bounds.watermark,
    hasMore,
  };
}

/**
 * 把保留下限推到 `through`，并删掉它之前的记录。
 *
 * 只在写入时顺手调用，所以裁剪永远发生在一次成功的业务写入之后——一个空转的
 * core 不会因为「时间到了」而丢掉谁的历史。
 */
export function prune(
  database: DatabaseSync,
  retained: number = RETAINED_EVENTS,
): number {
  const bounds = watermark(database);
  const through = bounds.watermark - Math.max(1, retained);
  if (through <= bounds.floor) return bounds.floor;
  database.prepare("DELETE FROM events WHERE seq <= ?").run(through);
  try {
    database
      .prepare(
        "UPDATE store_meta SET event_floor = ? WHERE singleton = 1 AND event_floor < ?",
      )
      .run(through, through);
  } catch {
    // 同 `bumpWatermark`：下限也能从表里最旧的那条推出来。
  }
  return through;
}
