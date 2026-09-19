import { z } from "zod";
import type { CanvasNode, Position } from "@armadra/shared";

import {
  itemSchema,
  referenceSchema,
  type Item,
  type Reference,
} from "./model";
import { itemsBounds } from "./geometry";
import { looksLikeMermaid } from "./mermaid/detect";

/**
 * 画布剪贴板（React Flow 计划 §2.8 / F19，归属 whiteboard）。
 *
 * 复制的载体是**系统剪贴板的 `text/plain`**：一段带签名的 JSON。这样
 * 两个窗口、两块画布、甚至重启之后都能粘贴，而不必在内存里养一个只有
 * 本进程认识的暂存区。粘到别处（编辑器、聊天框）也只是一段 JSON 文本，
 * 不会变成乱码。
 *
 * 认不出签名的内容按外部内容规则分流（§2.8 最后一条）：图片 → `wb.image`，
 * 文本 / URL → `wb.text`。这里只做判定，落地在 `dnd/external-content.ts`。
 *
 * 终端节点不进剪贴板：它的 `sessionId` 指着一个活着的 tmux 会话，复制一份
 * 出来只会得到两个节点抢同一个进程。
 */

export const CLIPBOARD_SIGNATURE = "canvas@1";

/** 节点只留能重建的那几个字段：id、时间戳、会话都由新建时重新生成。 */
const clipboardNodeSchema = z.object({
  type: z.string(),
  title: z.string(),
  color: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }),
  size: z.object({ width: z.number(), height: z.number() }).optional(),
  labels: z.array(z.string()).optional(),
  note: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export type ClipboardNode = z.infer<typeof clipboardNodeSchema>;

export const canvasClipboardSchema = z.object({
  armadra: z.literal(CLIPBOARD_SIGNATURE),
  items: z.array(itemSchema).default([]),
  nodes: z.array(clipboardNodeSchema).default([]),
  references: z.array(referenceSchema).default([]),
});

export type CanvasClipboard = z.infer<typeof canvasClipboardSchema>;

/** 复制不了的节点类型：会话是活的，复制一份出来只会两个节点抢一个进程。 */
export const UNCOPYABLE_NODE_TYPES: ReadonlySet<string> = new Set(["terminal"]);

/* -------------------------------- 写 -------------------------------------- */

export function buildClipboard(
  items: readonly Item[],
  nodes: readonly CanvasNode[],
  references: readonly Reference[] = [],
): CanvasClipboard {
  const copyable = nodes.filter(
    (node) => !UNCOPYABLE_NODE_TYPES.has(node.type),
  );
  const nodeIds = new Set(copyable.map((node) => node.id));
  const itemIds = new Set(items.map((item) => item.id));
  return {
    armadra: CLIPBOARD_SIGNATURE,
    items: items.map((item) => ({ ...item })),
    nodes: copyable.map((node) => ({
      type: node.type,
      title: node.title,
      color: node.color,
      position: { x: node.position.x, y: node.position.y },
      size: node.size ?? undefined,
      labels: node.labels ?? [],
      note: node.note ?? "",
      data: node.data as Record<string, unknown>,
    })),
    // 只留两端都在这次复制里的引用：指向没复制的节点的那些粘出来是死链。
    references: references.filter(
      (reference) =>
        itemIds.has(reference.itemId) && nodeIds.has(reference.nodeId),
    ),
  };
}

export function serializeClipboard(payload: CanvasClipboard): string {
  return JSON.stringify(payload);
}

/* -------------------------------- 读 -------------------------------------- */

/**
 * 认签名。不是我们的格式一律返回 null——调用方接着按外部内容处理，
 * 绝不猜。
 */
export function parseClipboard(
  text: string | null | undefined,
): CanvasClipboard | null {
  if (!text) return null;
  const trimmed = text.trimStart();
  // 先看第一个字符：一段普通文本走不到 JSON.parse，省掉一次异常。
  if (!trimmed.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = canvasClipboardSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function isCanvasClipboard(text: string | null | undefined): boolean {
  return parseClipboard(text) !== null;
}

/* -------------------------------- 落点 ------------------------------------ */

/** 剪贴板内容的整体包围盒（对象与节点一起算）。 */
export function clipboardBounds(
  payload: CanvasClipboard,
): { x: number; y: number; w: number; h: number } | null {
  const boxes = itemsBounds(payload.items);
  let minX = boxes?.x ?? Infinity;
  let minY = boxes?.y ?? Infinity;
  let maxX = boxes ? boxes.x + boxes.w : -Infinity;
  let maxY = boxes ? boxes.y + boxes.h : -Infinity;
  for (const node of payload.nodes) {
    const width = node.size?.width ?? 240;
    const height = node.size?.height ?? 200;
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export interface RelocateOptions {
  /** 粘贴落点（画布坐标）；内容的中心对齐到这里。 */
  at: Position;
  /** 新对象 id 的生成器；测试里换成可预测的序列。 */
  newId?: () => string;
}

/**
 * 把一份剪贴板内容搬到落点上，并换一整套新 id。
 *
 * 中心对齐而不是左上角对齐：粘贴的落点是「光标在哪」或「视口中心」，
 * 用户预期粘出来的东西出现在那个点上，而不是从那个点往右下角铺开。
 * 引用的 `id` 也要换——它就是 `ContextLink.id`，两条引用共用一个 id
 * 会让导出的 PNG 互相覆盖。
 */
export function relocateClipboard(
  payload: CanvasClipboard,
  { at, newId = () => crypto.randomUUID() }: RelocateOptions,
): CanvasClipboard {
  const bounds = clipboardBounds(payload);
  const dx = bounds ? at.x - (bounds.x + bounds.w / 2) : at.x;
  const dy = bounds ? at.y - (bounds.y + bounds.h / 2) : at.y;
  const itemIds = new Map<string, string>();
  const items = payload.items.map((item) => {
    const id = newId();
    itemIds.set(item.id, id);
    // 组员的坐标相对 Frame，而粘贴出来的东西一律落在页面级：连同
    // `parentId` 一起丢掉，坐标才和落点是同一个坐标系。
    return { ...item, id, parentId: null, x: item.x + dx, y: item.y + dy };
  });
  const nodes = payload.nodes.map((node) => ({
    ...node,
    position: { x: node.position.x + dx, y: node.position.y + dy },
  }));
  // 节点是重新建的，粘贴时才知道新 id，所以引用交给调用方接：这里只把
  // 对象 id 换掉，`nodeId` 留原值当占位。
  const references = payload.references
    .filter((reference) => itemIds.has(reference.itemId))
    .map((reference) => ({
      ...reference,
      id: newId(),
      itemId: itemIds.get(reference.itemId)!,
    }));
  return { armadra: CLIPBOARD_SIGNATURE, items, nodes, references };
}

/* ------------------------------ 外部内容分流 ------------------------------- */

export type PasteRoute = "canvas" | "image" | "mermaid" | "text" | "none";

/**
 * 一次粘贴走哪条路（§2.8）。
 *
 * 顺序有意义：签名最优先（我们自己的复制），然后是图片文件（截图粘贴的
 * `text/plain` 常常是空的），再看这段文本是不是 Mermaid，最后才当纯文本。
 * 四样都没有就什么也不做。
 *
 * `mermaid` 这一支落地时**先弹确认对话框**而不是直接画图：识别是前缀匹配，
 * 必然有误判，把一段 `graph` 开头的散文悄悄吞掉比多一次点击糟得多
 * （Mermaid 导入设计 D8）。
 */
export function routePaste(input: {
  text?: string | null;
  hasImage?: boolean;
}): PasteRoute {
  if (isCanvasClipboard(input.text)) return "canvas";
  if (input.hasImage) return "image";
  if (looksLikeMermaid(input.text)) return "mermaid";
  if (input.text && input.text.trim().length > 0) return "text";
  return "none";
}

/** 从 `DataTransfer` 里挑出图片文件（截图、浏览器里拖出来的图）。 */
export function imageFilesOf(
  transfer: DataTransfer | null | undefined,
  isImage: (file: { name: string; type: string }) => boolean,
): File[] {
  const files = Array.from(transfer?.files ?? []);
  const fromItems = Array.from(transfer?.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  const all = files.length > 0 ? files : fromItems;
  return all.filter((file) => isImage(file));
}
