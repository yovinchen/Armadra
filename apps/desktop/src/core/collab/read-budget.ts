import type { DatabaseSync } from "node:sqlite";
import { Refused } from "./refusals";

/**
 * 每条连线的读取预算（设计 `agent-delivery.md` §13、§7 的限速表）。
 *
 * `send-limits.ts` 管的是「一条边能被走多少次」，这个文件管的是「一条边能被读
 * 走多少字节」。两道闸的形状一样、理由也一样（失控的形状是**一条边**被反复
 * 走，不是一个节点很忙），差别只有一处：读取的账落在库里而不是内存里。
 *
 * 为什么落库：一次读取的代价是读者上下文里的 token，而那个上下文活过重启、活
 * 过页面刷新。把窗口放在内存里，意味着 core 一重启每条边的额度就回满——而刚
 * 被读走 1 MB 的那个 Agent 的上下文并不会因此空一点。审计那张表
 * （`context_reads`，迁移 0025）本来就要写，顺手就是这两个和。
 *
 * 两个数按「读者 → 目标」这一对算，不是按目标算：三个 Agent 各读同一个节点一
 * 次是正常的协作，一个 Agent 把同一个节点读三十次不是。
 */

/** 一条连线每分钟最多读走这么多字节。 */
export const READ_BUDGET_MINUTE_BYTES = 64 * 1024;

/** 一条连线每小时最多读走这么多字节。 */
export const READ_BUDGET_HOUR_BYTES = 1024 * 1024;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** 一次预算判定的结果。 */
export interface BudgetVerdict {
  readonly allowed: boolean;
  /** 还要等多久。`allowed` 时是 0。 */
  readonly retryAfterMs: number;
  /** 撞的是哪一个窗口，只在被拒时有意义。 */
  readonly window?: "minute" | "hour";
  /** 这个窗口里已经读走多少字节。 */
  readonly spent: number;
}

/**
 * 这条连线现在还能不能再读。**只问，不记**：一次被后面的门拦下的读取不该占掉
 * 额度，与 {@link import("./send-limits").SendLimits.rate} 同一条规矩。
 *
 * 判的是「已经花掉的」而不是「这次要花多少」：一次读取要给多少字节，要到读完
 * 才知道，而在读之前就拒绝一次超额的读，比读完再扔掉它省的多。所以额度是**事
 * 后**扣的（`context_reads` 的那一行），这里问的永远是上一次之后的账。
 */
export function checkReadBudget(
  database: DatabaseSync,
  reader: string,
  target: string,
  nowMs: number,
): BudgetVerdict {
  const minute = window(database, reader, target, nowMs, MINUTE_MS);
  if (minute.bytes >= READ_BUDGET_MINUTE_BYTES) {
    return {
      allowed: false,
      window: "minute",
      spent: minute.bytes,
      retryAfterMs: retryAfter(minute.oldestAtMs, nowMs, MINUTE_MS),
    };
  }
  const hour = window(database, reader, target, nowMs, HOUR_MS);
  if (hour.bytes >= READ_BUDGET_HOUR_BYTES) {
    return {
      allowed: false,
      window: "hour",
      spent: hour.bytes,
      retryAfterMs: retryAfter(hour.oldestAtMs, nowMs, HOUR_MS),
    };
  }
  return { allowed: true, retryAfterMs: 0, spent: minute.bytes };
}

/**
 * 判一次，不过就抛 `RATE_LIMITED`（§3.5，HTTP 429）。
 *
 * 拒绝的那句话必须说出**出路**，否则模型只会退避之后原样重试一遍同样大的读
 * 取：`summary` 是常数大小的，`--since` 只给新的，两条都不撞这堵墙。
 */
export function requireReadBudget(
  database: DatabaseSync,
  reader: string,
  target: string,
  title: string,
  nowMs: number,
): void {
  const verdict = checkReadBudget(database, reader, target, nowMs);
  if (verdict.allowed) return;
  const limit =
    verdict.window === "minute"
      ? `${READ_BUDGET_MINUTE_BYTES / 1024} KB/分钟`
      : `${READ_BUDGET_HOUR_BYTES / 1024} KB/小时`;
  throw new Refused(
    429,
    "RATE_LIMITED",
    `读「${title}」超出了这条连线的读取预算（${limit}，已用 ${Math.round(verdict.spent / 1024)} KB）。` +
      `等 ${Math.ceil(verdict.retryAfterMs / 1000)} 秒，或者改用 \`context summary\`（常数大小）` +
      "与 `context transcript --since`（只给上次之后的新条目）。",
    { retryable: true, retryAfterMs: verdict.retryAfterMs },
  );
}

interface Window {
  readonly bytes: number;
  /** 窗口里最早那一行的时刻；窗口是空的时候是 `undefined`。 */
  readonly oldestAtMs: number | undefined;
}

function window(
  database: DatabaseSync,
  reader: string,
  target: string,
  nowMs: number,
  spanMs: number,
): Window {
  const row = database
    .prepare(
      "SELECT COALESCE(SUM(bytes), 0) AS bytes, MIN(at_ms) AS oldest FROM context_reads " +
        "WHERE target_node_id = ? AND reader_node_id = ? AND at_ms > ?",
    )
    .get(target, reader, Math.trunc(nowMs - spanMs)) as
    | { bytes: number; oldest: number | null }
    | undefined;
  return {
    bytes: Number(row?.bytes ?? 0),
    oldestAtMs: row?.oldest === null || row?.oldest === undefined
      ? undefined
      : Number(row.oldest),
  };
}

/** 窗口里最早那一行滑出去还要多久。 */
function retryAfter(
  oldestAtMs: number | undefined,
  nowMs: number,
  spanMs: number,
): number {
  if (oldestAtMs === undefined) return spanMs;
  return Math.max(1_000, oldestAtMs + spanMs - nowMs);
}
