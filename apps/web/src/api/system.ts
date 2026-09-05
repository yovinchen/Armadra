import { z } from "zod";
import {
  healthSchema,
  legacyKanbanArchiveExportSchema,
  legacyKanbanArchivePageSchema,
  legacyKanbanArchiveSchema,
} from "@armadra/shared";
import { query, request } from "./request";

/* ------------------------------------ 数据 -------------------------------- */

/** `GET /api/data/info`（§24.1 数据页）。 */
export const dataInfoSchema = z.object({
  dataDir: z.string(),
  dbBytes: z.number().int().nonnegative(),
  conversations: z.number().int().nonnegative(),
  /** `0` = 永久保留。 */
  boardLogRetentionDays: z.number().int().nonnegative(),
});

export type DataInfo = z.infer<typeof dataInfoSchema>;

export const dataBackupSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
});

/* ---------------------------------- 画布归属 ------------------------------ */

/**
 * `GET /api/ownership`（H01 §4）—— 画布域此刻由谁写。
 *
 * `epoch` 是十进制字符串而不是数字：它在协议里是 u64，放进 JS number 会被
 * 舍入，相邻两个纪元读起来会一模一样，于是「旧纪元的写入要拒绝」这条规则
 * 就失效了。这里解析成 `bigint`，从此不再经过 `Number`。
 *
 * `phase` 是旧 Runtime 没有的字段：缺省按 `settled` 读，只有它明确说
 * 正在切换时前端才进入维护（只读）状态。
 */
export const canvasOwnershipSchema = z.object({
  domain: z.literal("canvas"),
  owner: z.enum(["runtime", "host"]),
  epoch: z
    .string()
    .regex(/^\d+$/)
    .transform((value) => BigInt(value)),
  phase: z.enum(["settled", "switching", "rollingBack"]).default("settled"),
  reasonCode: z.string(),
  updatedAt: z.string(),
});

export type CanvasOwnershipRecord = z.infer<typeof canvasOwnershipSchema>;

export const systemApi = {
  /**
   * `/api/health`，不是裸的 `/health`：Host 托管这份前端时，`/health` 是
   * Host **自己**的存活探针（纯文本），只有带 `/api` 前缀的路径才会被代理到
   * Runtime。这条查询问的是 Runtime，所以走带前缀的那一条。
   */
  health: () => request("/api/health", healthSchema),
  /** 画布域的写归属；读永远可用，写按它路由（H01 §4）。 */
  canvasOwnership: () => request("/api/ownership", canvasOwnershipSchema),
  /* ----------------------------------- 数据 ----------------------------- */
  /** 数据目录、数据库大小、对话索引条数、日志保留天数（§24.1 数据页）。 */
  dataInfo: () => request("/api/data/info", dataInfoSchema),
  /** 把 `canvas.db` 原样复制到同目录的 `…backup-manual-<时间戳>`。 */
  backupData: () =>
    request("/api/data/backup", dataBackupSchema, { method: "POST" }),
  legacyKanbanArchives: (cursor?: string, signal?: AbortSignal) =>
    request(
      `/api/data/legacy-kanban-archives?limit=50${cursor !== undefined ? `&cursor=${query(cursor)}` : ""}`,
      legacyKanbanArchivePageSchema,
      { signal },
    ),
  legacyKanbanArchive: (canvasId: string, signal?: AbortSignal) =>
    request(
      `/api/data/legacy-kanban-archives/${query(canvasId)}`,
      legacyKanbanArchiveSchema,
      { signal },
    ),
  exportLegacyKanbanArchive: (canvasId: string) =>
    request(
      `/api/data/legacy-kanban-archives/${query(canvasId)}/export`,
      legacyKanbanArchiveExportSchema,
    ),
};
