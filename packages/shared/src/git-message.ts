import { z } from "zod";
const digest = z.string().regex(/^[a-f0-9]{64}$/i);
const head = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)
  .nullable();
export const gitMessageProviderSchema = z.object({
  id: z.string(),
  label: z.string(),
  available: z.boolean(),
  reason: z.string().nullable(),
});
export const gitMessageProvidersSchema = z.array(gitMessageProviderSchema);
export const gitMessageSourceSchema = z.object({
  expectedHead: head,
  indexDigest: digest,
  sourceDigest: digest,
  includedFiles: z.array(z.string()),
  excludedFiles: z.array(z.string()),
  truncated: z.boolean(),
  redacted: z.boolean(),
});
export const gitMessageRequestSchema = z
  .object({
    provider: z.literal("claude-bare"),
    expectedHead: head,
    indexDigest: digest,
  })
  .strict();
export const gitMessageDraftSchema = gitMessageSourceSchema.extend({
  message: z.string().min(1).max(4096),
  provider: z.literal("claude-bare"),
});
export type GitMessageProvider = z.infer<typeof gitMessageProviderSchema>;
export type GitMessageSource = z.infer<typeof gitMessageSourceSchema>;
export type GitMessageRequest = z.infer<typeof gitMessageRequestSchema>;
export type GitMessageDraft = z.infer<typeof gitMessageDraftSchema>;
