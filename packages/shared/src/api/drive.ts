import { z } from "zod";

/**
 * 驱动租约的线上形状，浏览器与终端共用一份（设计 `agent-delivery.md` §6.2）。
 *
 * 一个会话一个持有者。读永远不需要租约，输入类动作需要。人点「接管」立即撤销
 * Agent 的租约，`generation` 随之 +1，旧世代的请求一律被拒。两个域的时间尺度
 * 不同，但**形状**一样，所以页面的徽标与四个错误码只学一遍。
 */
export const DRIVE_LEASE_STATES = [
  "free",
  "human",
  "humanTakeover",
  "agent",
] as const;

export const driveLeaseSchema = z.object({
  state: z.enum(DRIVE_LEASE_STATES),
  generation: z.number().int().nonnegative(),
  expiresAt: z.string().default(""),
  holder: z
    .object({
      kind: z.enum(["human", "agent"]),
      /** 人是 deviceId，Agent 是节点 id。 */
      id: z.string(),
      displayName: z.string().default(""),
    })
    .optional(),
});

export type DriveLeaseState = (typeof DRIVE_LEASE_STATES)[number];
export type DriveLease = z.infer<typeof driveLeaseSchema>;
