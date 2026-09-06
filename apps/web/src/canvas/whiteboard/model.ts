import { z } from "zod";

import {
  WHITEBOARD_COLORS,
  WHITEBOARD_SIZES,
} from "@/app/preferences/whiteboard";

/**
 * 白板文档 v2（React Flow 计划 §3.1，归属 whiteboard）。
 *
 * `boards.whiteboard_json` 对 Runtime 与 Host 是不透明字节（§3.5 核实过：
 * 两端只看长度与 sha256），所以格式由前端独占。v2 是一个带版本的 JSON：
 * 墨迹、文字、几何形、图片、直线各是一条 `Item`，白板对象 → Agent 的内容
 * 引用是一条 `Reference`。
 *
 * B0 只落地类型、zod 校验与空文档；五种对象的渲染、工具与样式面板在 B2。
 */

/** 只认这两个值：其它内容一律按空白板处理（§3.2「不迁移旧数据」）。 */
export const WHITEBOARD_ENGINE = "armadra-flow";
export const WHITEBOARD_VERSION = 2;

/** 白板对象 id 的前缀。`nodes` 行的 id 是裸 uuid，两者靠它区分。 */
export const ITEM_ID_PREFIX = "wb:";

export const ITEM_KINDS = ["ink", "text", "shape", "image", "line"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** 六种几何形（§1.2 F23）；旧引擎的另外 14 种不再支持。 */
export const GEOS = [
  "rectangle",
  "ellipse",
  "diamond",
  "triangle",
  "hexagon",
  "star",
] as const;
export type Geo = (typeof GEOS)[number];

export const DASHES = ["solid", "dashed", "dotted"] as const;
export type Dash = (typeof DASHES)[number];

export const FILLS = ["none", "semi", "solid"] as const;
export type Fill = (typeof FILLS)[number];

export const ALIGNS = ["start", "middle", "end"] as const;
export type Align = (typeof ALIGNS)[number];

/* --------------------------------- 样式 ----------------------------------- */

const colorSchema = z.enum(WHITEBOARD_COLORS);
const sizeSchema = z.enum(WHITEBOARD_SIZES);

export const itemStyleSchema = z.object({
  color: colorSchema,
  size: sizeSchema,
  dash: z.enum(DASHES).optional(),
  fill: z.enum(FILLS).optional(),
  align: z.enum(ALIGNS).optional(),
});

export type ItemStyle = z.infer<typeof itemStyleSchema>;

/* --------------------------------- 对象 ----------------------------------- */

/**
 * 所有对象共有的几何。坐标是画布单位；`parentId` 指向 `group` 节点时相对
 * 那个 Frame（§2.2）。`z` 升序即绘制顺序。
 */
const baseItemSchema = z.object({
  id: z.string().min(1),
  x: z.number(),
  y: z.number(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
  z: z.number(),
  parentId: z.string().nullable().optional(),
  style: itemStyleSchema,
});

/** 墨迹的一个采样点：`[x, y, 压力]`，坐标相对对象原点。 */
export const inkPointSchema = z.tuple([z.number(), z.number(), z.number()]);
export type InkPoint = z.infer<typeof inkPointSchema>;

/** 单条墨迹的点数上限（§3.1）；落成时由 `simplifyPoints` 压到这以内。 */
export const MAX_INK_POINTS = 4_000;

export const inkItemSchema = baseItemSchema.extend({
  kind: z.literal("ink"),
  highlight: z.boolean().optional(),
  points: z.array(inkPointSchema).max(MAX_INK_POINTS),
});

export const textItemSchema = baseItemSchema.extend({
  kind: z.literal("text"),
  text: z.string(),
});

export const shapeItemSchema = baseItemSchema.extend({
  kind: z.literal("shape"),
  geo: z.enum(GEOS),
  label: z.string().optional(),
});

export const imageItemSchema = baseItemSchema.extend({
  kind: z.literal("image"),
  /** 工作区相对路径（`.armadra/assets/…`）；显示 URL 由资产接口现算。 */
  assetPath: z.string().min(1),
  alt: z.string().optional(),
});

/** 直线 / 箭头的折点：`[x, y]`，相对对象原点。 */
export const linePointSchema = z.tuple([z.number(), z.number()]);
export type LinePoint = z.infer<typeof linePointSchema>;

export const lineItemSchema = baseItemSchema.extend({
  kind: z.literal("line"),
  points: z.array(linePointSchema).min(2),
  arrowStart: z.boolean().optional(),
  arrowEnd: z.boolean().optional(),
});

export const itemSchema = z.discriminatedUnion("kind", [
  inkItemSchema,
  textItemSchema,
  shapeItemSchema,
  imageItemSchema,
  lineItemSchema,
]);

export type InkItem = z.infer<typeof inkItemSchema>;
export type TextItem = z.infer<typeof textItemSchema>;
export type ShapeItem = z.infer<typeof shapeItemSchema>;
export type ImageItem = z.infer<typeof imageItemSchema>;
export type LineItem = z.infer<typeof lineItemSchema>;
export type Item = z.infer<typeof itemSchema>;

/* --------------------------------- 引用 ----------------------------------- */

/**
 * 白板对象 → Agent 的内容引用（§2.5 / F29）。
 *
 * `id` 就是 `ContextLink.id`，`.armadra/exports/<id>.png` 的文件名靠它稳定；
 * `itemId` 是 `wb:<uuid>`，`nodeId` 是终端 / 分组节点的 uuid。
 */
export const referenceSchema = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
  nodeId: z.string().min(1),
});

export type Reference = z.infer<typeof referenceSchema>;

/* -------------------------------- 白板文档 --------------------------------- */

/**
 * `legacy` 是转换记账位。§3.2 决定不迁移旧数据，所以现在没有任何代码写它；
 * 校验仍然放行，免得未来某版写了之后本版打开就整块判成未知格式。
 */
export const whiteboardLegacySchema = z
  .object({
    engine: z.string(),
    sha256: z.string(),
    bytes: z.number(),
    backup: z.string().optional(),
  })
  .loose();

export const whiteboardDocSchema = z.object({
  engine: z.literal(WHITEBOARD_ENGINE),
  version: z.literal(WHITEBOARD_VERSION),
  items: z.array(itemSchema),
  references: z.array(referenceSchema),
  legacy: whiteboardLegacySchema.optional(),
});

export type WhiteboardDoc = z.infer<typeof whiteboardDocSchema>;

export function emptyWhiteboard(): WhiteboardDoc {
  return {
    engine: WHITEBOARD_ENGINE,
    version: WHITEBOARD_VERSION,
    items: [],
    references: [],
  };
}

/** 空文档没有对象也没有引用；序列化前用它跳过一次 `JSON.stringify`。 */
export function isEmptyWhiteboard(doc: WhiteboardDoc): boolean {
  return doc.items.length === 0 && doc.references.length === 0 && !doc.legacy;
}

/* -------------------------------- id 辅助 ---------------------------------- */

export function toItemId(uuid: string): string {
  return uuid.startsWith(ITEM_ID_PREFIX) ? uuid : `${ITEM_ID_PREFIX}${uuid}`;
}

export function fromItemId(id: string): string {
  return id.startsWith(ITEM_ID_PREFIX) ? id.slice(ITEM_ID_PREFIX.length) : id;
}

export function isItemId(id: string): boolean {
  return id.startsWith(ITEM_ID_PREFIX);
}
