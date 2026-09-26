import { z } from "zod";

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
});

export const healthSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
  /** core 登记的能力位；旧 core 没有这一段。 */
  capabilities: z.record(z.string(), z.boolean()).optional(),
  /**
   * core 那台机器的 `process.platform`，与节点没指定 shell 时终端跑的程序名
   * （`cmd.exe` / `zsh`）。本机路径的校验、启动行的引用都按它们；旧 core 没有。
   */
  platform: z.string().optional(),
  defaultShell: z.string().optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
export type Health = z.infer<typeof healthSchema>;
