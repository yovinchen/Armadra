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
});

export type ApiError = z.infer<typeof apiErrorSchema>;
export type Health = z.infer<typeof healthSchema>;
