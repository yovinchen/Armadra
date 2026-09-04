import * as React from "react";
import type { ContextLink } from "@ai-coding-canvas/shared";
import {
  renderPlaintextFromRichText,
  type Editor,
  type TLArrowBinding,
  type TLShape,
  type TLShapeId,
} from "tldraw";

import { runtimeApi } from "@/api/client";
import { t } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { assetPath } from "./assets";
import { useEditorHandle } from "./editor-context";
import { isDocumentShapeId, isUuid, toNodeId } from "./shapes/aicc-shape";
import { arrowAiccMeta } from "./sync/derive";

/**
 * 内容链接：白板上的图形连到节点（tldraw 计划 §6.3）。
 *
 * 一条 tldraw `arrow` 一端绑到节点 shape（`aicc` / 作为分组的 `frame`）、另一端
 * 绑到白板 shape（文字 / 形状 / 手绘 / 图片 / 直线 / 高亮 / 另一个画框）时，它不是
 * 一条 `edges` 行（那种两端都是节点，`shapes/LinkArrow.ts` 会换成 `link` shape），
 * 而是**内容链接**：节点侧的 Agent 能把那个图形当资料读。
 *
 * 读到什么按图形类型来：
 *
 * | shape | `ContextLink.content` |
 * | --- | --- |
 * | `text` | `text`（富文本取纯文本），不导出 PNG |
 * | `geo` 带文字 | `text` + `pngPath` |
 * | `image` | `pngPath` = 资产的 `meta.aicc.path`（文件已经在工作区里，不重复导出） |
 * | `draw` / `line` / `highlight` / 无文字的 `geo` | `pngPath`（栅格化后上传） |
 * | `frame` | `pngPath` + 框内所有文字拼成的 `text` |
 *
 * **稳定 uuid 记在 `arrow.meta.aicc.contentId`**，不是从 shape id 派生
 * （uuid v5）。两条理由：
 *
 *  1. 前端没有 sha-1，uuid v5 得自己实现一份；而 arrow 本来就要写 `meta.aicc`
 *     （方向与颜色的 `styled` 标记），多一个字段是零成本。
 *  2. 导出路径是 `.aicc/exports/<uuid>.png`。id 跟着**这条连线**走时，用户把线
 *     改指到另一个图形只会覆盖同一个文件；跟着 shape id 走则每换一次目标就在
 *     工作区里留下一个没人再读的 PNG。
 */

/** 栅格化 + 上传的防抖：连着改一笔不要每一帧都导出一次。 */
export const EXPORT_DELAY_MS = 2000;

/** 标题截断（文字图形取正文前 40 字）。 */
export const TITLE_MAX = 40;

/** `ContextLink.content.text` 的上限，与 Runtime 的校验同一个数。 */
export const MAX_CONTENT_TEXT_BYTES = 20_000;

/** 一个节点的链接文档最多 64 条（`contextLinksRequestSchema`）。 */
export const MAX_LINKS = 64;

/**
 * 可以当内容读的白板 shape 类型 → 标题用的 i18n 键。
 *
 * 表里没有的类型（`bookmark` / `embed` / `video` / 另一条 `arrow`）不算内容链接：
 * 那条箭头仍然是一条普通的白板箭头，只是没人读它。
 */
export const CONTENT_TYPE_KEYS: Record<string, string> = {
  text: "content.text",
  geo: "content.geo",
  draw: "content.draw",
  image: "content.image",
  line: "content.line",
  highlight: "content.highlight",
  frame: "content.frame",
};

/** 内容链接在链接文档里的 `kind`。 */
export const SHAPE_KIND = "shape";

/* -------------------------------- 形状判定 -------------------------------- */

interface ShapeLike {
  id: string;
  type: string;
  props?: unknown;
  meta?: Record<string, unknown>;
}

/** 这个 shape 是一个节点吗（`aicc`，或作为分组的 `frame`）？ */
export function isNodeShapeRecord(shape: ShapeLike | undefined): boolean {
  if (!shape) return false;
  if (shape.type === "aicc") return true;
  return shape.type === "frame" && isDocumentShapeId(shape.id);
}

/** 这个 shape 能当内容读吗？节点与 `link` 不算。 */
export function isContentShape(shape: ShapeLike | undefined): boolean {
  if (!shape || isNodeShapeRecord(shape)) return false;
  return Object.hasOwn(CONTENT_TYPE_KEYS, shape.type);
}

export interface ContentEnds {
  /** 节点 uuid（链接文档挂在它名下）。 */
  nodeId: string;
  /** 白板 shape 的 id。 */
  shapeId: TLShapeId;
  /** 节点在箭头的哪一端；箭头头要指向它。 */
  nodeEnd: "start" | "end";
}

/**
 * 一条 arrow 是不是内容链接？
 *
 * 两端都要绑上：一端是节点、另一端是可读的白板 shape。两端同为节点是一条
 * `edges` 行（`LinkArrow` 换成 `link` shape），两端都不是节点就是一条普通的
 * 白板箭头，都返回 null。
 */
export function contentArrowEnds(
  arrowId: string,
  bindings: readonly TLArrowBinding[],
  getShape: (id: TLShapeId) => ShapeLike | undefined,
): ContentEnds | null {
  const mine = bindings.filter((binding) => binding.fromId === arrowId);
  const start = mine.find((binding) => binding.props.terminal === "start");
  const end = mine.find((binding) => binding.props.terminal === "end");
  if (!start || !end) return null;

  const startShape = getShape(start.toId);
  const endShape = getShape(end.toId);
  const startIsNode = isNodeShapeRecord(startShape);
  const endIsNode = isNodeShapeRecord(endShape);
  if (startIsNode === endIsNode) return null;

  const nodeBinding = startIsNode ? start : end;
  const contentBinding = startIsNode ? end : start;
  const contentShape = startIsNode ? endShape : startShape;
  if (!isContentShape(contentShape)) return null;

  return {
    nodeId: toNodeId(nodeBinding.toId),
    shapeId: contentBinding.toId,
    nodeEnd: startIsNode ? "start" : "end",
  };
}

/* ------------------------------- 稳定 uuid -------------------------------- */

/** 这条箭头已经有内容 id 了吗？ */
export function contentIdOf(arrow: {
  meta?: Record<string, unknown>;
}): string | null {
  const id = arrowAiccMeta(arrow).contentId;
  return typeof id === "string" && isUuid(id) ? id : null;
}

/**
 * 取（必要时生成）这条箭头的内容 id。
 *
 * 生成只发生一次：之后它跟着 arrow 的 `meta` 一起进白板快照，刷新往返恒等，
 * `.aicc/exports/<id>.png` 也就一直是同一个文件。写 meta 不进撤销栈——它是
 * 记账，不是用户的一步操作。
 */
export function ensureContentId(editor: Editor, arrow: ShapeLike): string {
  const existing = contentIdOf(arrow);
  if (existing) return existing;
  const contentId = crypto.randomUUID();
  editor.run(
    () => {
      editor.updateShape({
        id: arrow.id as TLShapeId,
        type: arrow.type,
        meta: { ...arrow.meta, aicc: { ...arrowAiccMeta(arrow), contentId } },
      } as never);
    },
    { history: "ignore" },
  );
  return contentId;
}

/* --------------------------------- 文字 ----------------------------------- */

/** 富文本 → 纯文本；没有正文时是空串。 */
export function plainText(editor: Editor, shape: ShapeLike): string {
  const richText = (shape.props as { richText?: unknown } | undefined)?.richText;
  if (!richText) return "";
  try {
    return renderPlaintextFromRichText(
      editor,
      richText as Parameters<typeof renderPlaintextFromRichText>[1],
    ).trim();
  } catch {
    return "";
  }
}

/**
 * 这个 shape 的可读文字。
 *
 * 画框取框内所有子孙的文字（§6.3「frame 是最推荐的链接单位」：Agent 拿到整块
 * 的 PNG 加框内所有文字），其余取自己的富文本。
 */
export function shapeText(editor: Editor, shape: TLShape): string {
  if (shape.type !== "frame") return plainText(editor, shape);
  const parts: string[] = [];
  for (const id of editor.getShapeAndDescendantIds([shape.id])) {
    if (id === shape.id) continue;
    const child = editor.getShape(id);
    if (!child) continue;
    const text = plainText(editor, child);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

/** 按字节截断（Runtime 校验的是字节数）。 */
export function clampText(text: string, limit = MAX_CONTENT_TEXT_BYTES): string {
  if (new TextEncoder().encode(text).length <= limit) return text;
  let out = text;
  while (out.length > 0 && new TextEncoder().encode(out).length > limit) {
    out = out.slice(0, Math.max(0, Math.floor(out.length * 0.9) - 1));
  }
  return out;
}

/**
 * 链接的标题：文字取正文前 40 字，画框取框名，其余取类型名。
 *
 * `label` 是 i18n 的取词函数，单测里换成恒等函数就不用起 i18n。
 */
export function contentTitle(
  shape: ShapeLike,
  text: string,
  label: (key: string) => string = t,
): string {
  if (shape.type === "frame") {
    const name = (shape.props as { name?: string } | undefined)?.name?.trim();
    if (name) return name;
  }
  if (shape.type === "text") {
    const line = text.trim().replace(/\s+/gu, " ");
    if (line) {
      return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line;
    }
  }
  return label(CONTENT_TYPE_KEYS[shape.type] ?? "content.shape");
}

/* ------------------------------- 变化判定 --------------------------------- */

/**
 * 「这个图形还是不是上次导出的那个样子」。
 *
 * 只看会影响导出结果的东西：自己的 `props` / `meta`（不含 `x/y`——挪一下位置
 * 画出来一模一样），画框还要连框内所有子孙一起看（含它们的相对坐标）。
 */
export function shapeSignature(editor: Editor, id: TLShapeId): string {
  const shape = editor.getShape(id);
  if (!shape) return "";
  const ids =
    shape.type === "frame" ? [...editor.getShapeAndDescendantIds([id])] : [id];
  const parts: string[] = [];
  for (const child of [...ids].sort()) {
    const record = editor.getShape(child);
    if (!record) continue;
    parts.push(
      JSON.stringify(
        child === id
          ? { t: record.type, p: record.props, m: record.meta }
          : {
              t: record.type,
              x: record.x,
              y: record.y,
              r: record.rotation,
              p: record.props,
              m: record.meta,
            },
      ),
    );
  }
  return parts.join("|");
}

/* ------------------------------- 内容解析 --------------------------------- */

export interface ContentDeps {
  /** 栅格化后的 PNG → 工作区相对路径。 */
  exportPng(exportId: string, dataUrl: string): Promise<string>;
  label?(key: string): string;
}

export interface ResolvedContent {
  title: string;
  content: NonNullable<ContextLink["content"]>;
}

/**
 * 一个白板 shape → 链接文档里的那一条。
 *
 * 图片直接给资产文件的工作区相对路径（Phase 3 的 `TLAssetStore` 已经把字节落到
 * `.aicc/assets/<hash>.<ext>` 了），**不重复导出**；文字不需要图；其余栅格化。
 */
export async function resolveContent(
  editor: Editor,
  shapeId: TLShapeId,
  contentId: string,
  deps: ContentDeps,
): Promise<ResolvedContent | null> {
  const shape = editor.getShape(shapeId);
  if (!shape || !isContentShape(shape)) return null;

  const text = shapeText(editor, shape);
  const title = contentTitle(shape, text, deps.label ?? t);
  const content: NonNullable<ContextLink["content"]> = {};
  if (text) content.text = clampText(text);

  if (shape.type === "image") {
    const assetId = (shape.props as { assetId?: string | null }).assetId;
    const path = assetId ? assetPath(editor.getAsset(assetId as never)) : null;
    if (path) content.pngPath = path;
    return { title, content };
  }

  if (shape.type !== "text") {
    const image = await editor.toImageDataUrl([shapeId], {
      background: true,
      padding: 16,
      scale: 2,
      format: "png",
    });
    content.pngPath = await deps.exportPng(contentId, image.url);
  }

  return { title, content };
}

/* -------------------------------- 收集与推送 ------------------------------- */

export interface ContentDescriptor extends ContentEnds {
  arrowId: TLShapeId;
  contentId: string;
}

/**
 * 画布上所有的内容链接。
 *
 * 缺 `contentId` 的箭头在这里补一个：`LinkArrow` 在交互结束时就会写，
 * 但远端合并进来的箭头（Agent 改画布、另一个标签页）不走那条路。
 */
export function collectContentLinks(editor: Editor): ContentDescriptor[] {
  const found: ContentDescriptor[] = [];
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== "arrow") continue;
    const bindings = editor.getBindingsFromShape<TLArrowBinding>(
      shape.id,
      "arrow",
    );
    const ends = contentArrowEnds(shape.id, bindings, (id) =>
      editor.getShape(id),
    );
    if (!ends) continue;
    found.push({
      ...ends,
      arrowId: shape.id,
      contentId: ensureContentId(editor, shape),
    });
  }
  return found;
}

/** 终端节点 id → 它的内容链接。 */
export type ContentLinkMap = Record<string, ContextLink[]>;

function sameMap(a: ContentLinkMap, b: ContentLinkMap): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 画布上的内容链接（含已经解析好的 `content`）。
 *
 * 每次白板改动重排一次 2 秒的定时器：拖一笔手绘会产生几十条 store 事件，
 * 每条都栅格化上传一次显然不行。签名没变的图形直接复用上一次的结果，所以
 * 只是移动一下位置不会触发导出。
 */
export function useContentLinks(): ContentLinkMap {
  const editor = useEditorHandle();
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  const [links, setLinks] = React.useState<ContentLinkMap>({});

  React.useEffect(() => {
    if (!editor || !workspaceId) {
      setLinks((previous) => (sameMap(previous, {}) ? previous : {}));
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** `contentId` → 上次解析的结果，签名没变就直接用。 */
    const cache = new Map<string, { signature: string; link: ContextLink }>();

    const deps: ContentDeps = {
      exportPng: async (exportId, dataUrl) => {
        const response = await runtimeApi.exportPng(
          workspaceId,
          exportId,
          dataUrl,
        );
        return response.relativePath;
      },
    };

    const recompute = async (): Promise<void> => {
      const descriptors = collectContentLinks(editor);
      const alive = new Set(descriptors.map((item) => item.contentId));
      for (const key of [...cache.keys()]) {
        if (!alive.has(key)) cache.delete(key);
      }

      const next: ContentLinkMap = {};
      for (const item of descriptors) {
        const signature = shapeSignature(editor, item.shapeId);
        const cached = cache.get(item.contentId);
        let link = cached?.signature === signature ? cached.link : null;
        if (!link) {
          let resolved: ResolvedContent | null = null;
          try {
            resolved = await resolveContent(
              editor,
              item.shapeId,
              item.contentId,
              deps,
            );
          } catch {
            // 导出或上传失败：这一轮跳过，下一次改动会重试。用户不需要被打扰。
            resolved = null;
          }
          if (disposed) return;
          if (!resolved) continue;
          link = {
            id: item.contentId,
            title: resolved.title,
            kind: SHAPE_KIND,
            content: resolved.content,
          };
          cache.set(item.contentId, { signature, link });
        }
        (next[item.nodeId] ??= []).push(link);
      }
      if (disposed) return;
      setLinks((previous) => (sameMap(previous, next) ? previous : next));
    };

    const schedule = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void recompute();
      }, EXPORT_DELAY_MS);
    };

    schedule();
    const off = editor.store.listen(schedule, { scope: "document" });
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      off();
    };
  }, [editor, workspaceId]);

  return links;
}
