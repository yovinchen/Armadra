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
/**
 * Drafting options. Both only steer the instruction the isolated provider is
 * given; neither changes what is read from the repository, what is redacted, or
 * the digests the draft is checked against.
 */
export const GIT_MESSAGE_LANGUAGES = ["zh", "en"] as const;
export const gitMessageLanguageSchema = z.enum(GIT_MESSAGE_LANGUAGES);
export type GitMessageLanguage = z.infer<typeof gitMessageLanguageSchema>;

export const gitMessageRequestSchema = z
  .object({
    provider: z.literal("claude-bare"),
    expectedHead: head,
    indexDigest: digest,
    /** Subject/body language. Defaults to English, as the provider does. */
    language: gitMessageLanguageSchema.default("en"),
    /** Ask for a Conventional Commits subject (`type(scope): summary`). */
    conventional: z.boolean().default(false),
  })
  .strict();
export const gitMessageDraftSchema = gitMessageSourceSchema.extend({
  message: z.string().min(1).max(4096),
  provider: z.literal("claude-bare"),
  /** Echoed back so a draft can be told apart from one made with other options. */
  language: gitMessageLanguageSchema.default("en"),
  conventional: z.boolean().default(false),
});
export type GitMessageProvider = z.infer<typeof gitMessageProviderSchema>;
export type GitMessageSource = z.infer<typeof gitMessageSourceSchema>;
export type GitMessageRequest = z.infer<typeof gitMessageRequestSchema>;
export type GitMessageDraft = z.infer<typeof gitMessageDraftSchema>;
