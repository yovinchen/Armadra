import { z } from "zod";

/**
 * 用量胶囊（plan §19）。
 *
 * The runtime reads each provider's own credentials, calls the provider's
 * usage endpoint and maps the answer down to this shape. Tokens, account ids,
 * e-mail addresses and plan names never cross the wire — a window is a
 * percentage and a reset time, nothing else.
 */
// 模型额度有独立 key（例如 seven_day_sonnet、codex_other:primary）。
export const usageWindowKeySchema = z.string().min(1);

export const usageWindowSchema = z.object({
  key: usageWindowKeySchema,
  /** 单位缩写（`5h` / `7d`）；前端过一层 i18n，认不出就原样显示。 */
  label: z.string(),
  group: z.string().optional(),
  usedPercent: z.number().min(0).max(100),
  /**
   * 没有上限的额度桶（Copilot 的 chat / completions）。此时 `usedPercent`
   * 是 0 但不代表「没用」，界面显示「无限制」而不是空进度条。
   */
  unlimited: z.boolean().optional(),
  /** RFC 3339，`null` 表示 provider 没给重置时间。 */
  resetsAt: z.string().nullable(),
});

export const usageProviderIdSchema = z.enum(["claude", "codex", "copilot"]);

/**
 * `unavailable` = 本机没有该 provider 的凭据；`error` = 有凭据但取不到
 * （401 / 网络 / 字段不符）。两者在界面上都不弹提示（§19「刷新」）。
 */
export const usageProviderStatusSchema = z.enum(["ok", "unavailable", "error"]);

/**
 * 凭据**放在哪**——不是凭据本身。设置页的「账号与用量」用它显示
 * 钥匙串 / 文件 / 未找到；旧 Runtime 没有这个字段，所以给了默认值。
 */
export const usageCredentialSourceSchema = z
  .enum(["keychain", "file", "none"])
  .optional();

/** 预付余额（Codex credits）。只有数字，没有账户信息。 */
export const usageCreditsSchema = z.object({ balance: z.number() });

export const usageProviderSchema = z.object({
  id: usageProviderIdSchema,
  status: usageProviderStatusSchema,
  /**
   * `status: "error"` 的原因代码（Runtime `UsageFailure`：`expired_credentials`、
   * `network`、`unauthorized` …）。只有代码，没有上游文本；新 Runtime 可能多出
   * 前端还不认识的值，所以是字符串而不是枚举，前端认不出的按通用原因显示。
   */
  reason: z.string().optional(),
  credentialSource: usageCredentialSourceSchema,
  windows: z.array(usageWindowSchema),
  credits: usageCreditsSchema.optional(),
  /** 数字来自本地 CLI 回退而不是 provider 自己的 OAuth 接口。 */
  viaCli: z.boolean().optional(),
  fetchedAt: z.string().nullable(),
});

export const usageSchema = z.object({
  providers: z.array(usageProviderSchema),
  refreshAvailableAt: z.string().nullable().optional(),
});

/* ------------------------------ 托盘迷你条 -------------------------------- */

/* -------------------------------- 本地成本 -------------------------------- */

/**
 * 本地成本统计（§4.2）。Runtime 扫描本机 Claude / Codex 的 JSONL 转录，
 * 只汇总 token 计数；转录正文、会话 id、项目路径都不会出现在这里。
 */
export const costTokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheCreation: z.number(),
});

export const costModelSchema = z.object({
  model: z.string(),
  tokens: costTokensSchema,
  /** `null` = 价格表里没有这个模型，只显示 token，不显示估算费用。 */
  costUsd: z.number().nullable(),
});

export const costWindowSchema = z.object({
  tokens: costTokensSchema,
  costUsd: z.number(),
  /** false = 窗口里至少有一个模型没有价格，总额偏低。 */
  complete: z.boolean(),
  models: z.array(costModelSchema),
});

export const costDaySchema = costWindowSchema.extend({
  /** 本地日期 `YYYY-MM-DD`。 */
  date: z.string(),
});

export const costSessionSchema = z.object({
  provider: z.string(),
  models: z.array(z.string()),
  tokens: costTokensSchema,
  costUsd: z.number(),
  complete: z.boolean(),
  updatedAt: z.string(),
});

/** `disabled` = 设置里关掉了扫描；`unavailable` = 本机没有可读的转录。 */
export const costStatusSchema = z.enum(["ok", "disabled", "unavailable"]);

/* ------------------------------ 多维度范围 ------------------------------- */

/**
 * `local` = 这个 agent 有本地可解析的转录，数字是真的；`none` = 目前没有任何
 * 本地来源，token 一律为 0，界面显示「暂无本地用量数据」而不是一根空柱。
 */
export const costAgentSourceSchema = z.enum(["local", "none"]);

/** 一个 agent 在某个窗口里的用量。`agent` 是注册表里的 id（`claude` / `codex` …）。 */
export const costAgentSchema = z.object({
  agent: z.string(),
  tokens: costTokensSchema,
  costUsd: z.number(),
  complete: z.boolean(),
  source: costAgentSourceSchema,
});

/**
 * 时间轴上的一个点。`key` 在小时粒度是本地 `YYYY-MM-DDTHH`，在日粒度是本地
 * `YYYY-MM-DD`；同一条轴上所有点粒度一致。
 */
export const costPointSchema = costWindowSchema.extend({
  key: z.string(),
  agents: z.array(costAgentSchema),
  /** 这个点里有活动的转录文件数——一个文件就是一个会话。 */
  sessions: z.number(),
});

export const costRangeKeySchema = z.enum(["24h", "7d", "30d", "all"]);

export const costRangeSchema = z.object({
  granularity: z.enum(["hour", "day"]),
  /** 由旧到新、连续、零填充：24h 是 24 个小时，7d / 30d 是 7 / 30 天，all 从最早有记录的那天到今天。 */
  points: z.array(costPointSchema),
  totals: costWindowSchema,
  /** 花得最多的在前，然后是 token 最多的。 */
  byModel: z.array(costModelSchema),
  /** 固定列出注册表里的每个 agent，按注册表顺序；没有本地来源的标 `source: "none"`。 */
  byAgent: z.array(costAgentSchema),
  peak: z
    .object({ key: z.string(), tokens: costTokensSchema, costUsd: z.number() })
    .nullable(),
  /** 有活动的点数。 */
  activeIntervals: z.number(),
  /** 连续有活动的最长点数。 */
  longestStreak: z.number(),
  /** 整个范围里有活动的转录文件数（去重）。 */
  sessions: z.number(),
});

export const costRangesSchema = z.object({
  "24h": costRangeSchema,
  "7d": costRangeSchema,
  "30d": costRangeSchema,
  all: costRangeSchema,
});

export const costSummarySchema = z.object({
  status: costStatusSchema,
  today: costWindowSchema,
  last30Days: costWindowSchema,
  currentSession: costSessionSchema.optional(),
  /** 由旧到新，含当天，固定 30 项；没有活动的那天也在，值为 0。 */
  daily: z.array(costDaySchema),
  ranges: costRangesSchema,
  unpricedModels: z.array(z.string()),
  files: z.record(z.string(), z.number()),
  truncated: z.boolean(),
  scannedAt: z.string().nullable().optional(),
  refreshAvailableAt: z.string().nullable().optional(),
});

export type Usage = z.infer<typeof usageSchema>;
export type UsageProvider = z.infer<typeof usageProviderSchema>;
export type UsageProviderId = z.infer<typeof usageProviderIdSchema>;
export type UsageProviderStatus = z.infer<typeof usageProviderStatusSchema>;
export type UsageWindow = z.infer<typeof usageWindowSchema>;
export type UsageWindowKey = z.infer<typeof usageWindowKeySchema>;
export type UsageCredentialSource = z.infer<typeof usageCredentialSourceSchema>;
export type UsageCredits = z.infer<typeof usageCreditsSchema>;
export type CostTokens = z.infer<typeof costTokensSchema>;
export type CostModel = z.infer<typeof costModelSchema>;
export type CostWindow = z.infer<typeof costWindowSchema>;
export type CostDay = z.infer<typeof costDaySchema>;
export type CostSession = z.infer<typeof costSessionSchema>;
export type CostStatus = z.infer<typeof costStatusSchema>;
export type CostAgentSource = z.infer<typeof costAgentSourceSchema>;
export type CostAgent = z.infer<typeof costAgentSchema>;
export type CostPoint = z.infer<typeof costPointSchema>;
export type CostRangeKey = z.infer<typeof costRangeKeySchema>;
export type CostRange = z.infer<typeof costRangeSchema>;
export type CostRanges = z.infer<typeof costRangesSchema>;
export type CostSummary = z.infer<typeof costSummarySchema>;
