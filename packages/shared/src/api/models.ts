import { z } from "zod";

/**
 * 模型目录（用户实测反馈 F10）。
 *
 * 价格与上下文上限的来源：Runtime 每天从 models.dev 取一次，缓存在数据目录。
 * 这里的 schema 只描述**目录本身**——它从哪来、什么时候取的——这样成本面板旁边
 * 能写清楚“这些价格是谁的”，而不是留给用户猜。
 *
 * `builtIn` 表示还没取到过任何目录：此时报价来自随构建发布的内置表，界面应当
 * 如实这么说，而不是显示一个假的更新时间。
 */
export const modelCatalogSourceSchema = z.enum(["network", "cache", "builtIn"]);
export type ModelCatalogSource = z.infer<typeof modelCatalogSourceSchema>;

/** USD / 百万 token。缺失的缓存价按 0 记，即“该 provider 不单独计费”。 */
export const modelCostSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().default(0),
  cacheWrite: z.number().default(0),
});
export type ModelCost = z.infer<typeof modelCostSchema>;

export const modelLimitSchema = z.object({
  context: z.number().optional(),
  output: z.number().optional(),
});

export const catalogModelSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
  name: z.string(),
  /** 目录没有公布可用价格时缺失——不是 0，0 会被读成“免费”。 */
  cost: modelCostSchema.optional(),
  limit: modelLimitSchema.default({}),
  /** `YYYY-MM-DD`；模型菜单按它倒序。 */
  releaseDate: z.string().optional(),
  reasoning: z.boolean().default(false),
});
export type CatalogModel = z.infer<typeof catalogModelSchema>;

export const modelCatalogSchema = z.object({
  source: modelCatalogSourceSchema,
  /** RFC 3339；从没取到过时缺失。 */
  fetchedAt: z.string().optional(),
  url: z.string(),
  ageHours: z.number().optional(),
  /** 当前能算出价格的模型数（内置表 + 目录 + 用户覆盖文件）。 */
  pricedModels: z.number(),
  /** 刷新没成功时的原因；此时其余字段仍描述内存里那份可用目录。 */
  refreshError: z.string().optional(),
  models: z.array(catalogModelSchema).default([]),
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
