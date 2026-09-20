import { z } from "zod";
import { healthSchema } from "@armadra/shared";
import { request } from "./request";

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

export const systemApi = {
  /**
   * `/api/health`，不是裸的 `/health`：服务器壳把 `/health` 留给它自己的
   * 存活探针，页面问的是 core 那份文档，所以走带 `/api` 前缀的那一条。
   */
  health: () => request("/api/health", healthSchema),
  /* ----------------------------------- 数据 ----------------------------- */
  /** 数据目录、数据库大小、对话索引条数、日志保留天数（§24.1 数据页）。 */
  dataInfo: () => request("/api/data/info", dataInfoSchema),
  /** 把 `canvas.db` 原样复制到同目录的 `…backup-manual-<时间戳>`。 */
  backupData: () =>
    request("/api/data/backup", dataBackupSchema, { method: "POST" }),
};
