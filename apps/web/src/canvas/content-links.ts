import * as React from "react";
import type { BoardDocument, ContextLink } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { t } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { assetIdOf, assetUrlFor } from "./assets";
import {
  frameSignature,
  frameSource,
  frameSummaryText,
  type FrameSource,
} from "./frame-reference";
import { toItemId, type Item, type WhiteboardDoc } from "./whiteboard/model";
import type { ColorScheme } from "./whiteboard/palette";
import { rasterizeItems } from "./whiteboard/raster";
import { canvasScheme } from "./whiteboard/scheme";

/**
 * 内容引用：白板对象 → Agent（React Flow 计划 §2.5 / F29，归属 B5）。
 *
 * 旧引擎里一条引用是「一端绑节点、一端绑白板 shape」的箭头对象，收集时得
 * 把编辑器里所有箭头连同 binding 翻一遍。现在它就是
 * `whiteboard.references` 里的一行 `{ id, itemId, nodeId }`（§3.1），所以这
 * 个模块只读 `canvas-store` 的一份内存真相，不再需要编辑器。
 *
 * 跨端契约一个字段都没变（§2.5）：`ContextLink.content` 仍是
 * `{ status, sourceShapeId, shapeType, text, textTruncated, pngPath }`，
 * Runtime 的 `collab/context_link.rs` 不动。变的只有两处来源——
 *
 *  - `sourceShapeId` 填 `wb:<uuid>`，`shapeType` 填 `ink / text / shape /
 *    image / line`（提示字段，Runtime 不按它分支）；
 *  - PNG 由自写的 `whiteboard/raster.ts` 画，不再是编辑器的 `toImageDataUrl`。
 *
 * 发布 / 缓存 / 重试的状态机原样保留：文字与准备状态立即发布，栅格化按
 * 两秒截止时间批量跑；导出串行、过期结果丢弃、失败最多三次，之后靠
 * `REFRESH_CONTENT_EVENT` 显式重试。
 */

/** 栅格化 + 上传的防抖：连着改一笔不要每一帧都导出一次。 */
export const EXPORT_DELAY_MS = 2000;

/** 标题截断（文字对象取正文前 40 字）。 */
export const TITLE_MAX = 40;

/** `ContextLink.content.text` 的上限，与 Runtime 的校验同一个数。 */
export const MAX_CONTENT_TEXT_BYTES = 20_000;

/** 一个节点的链接文档最多 64 条（`contextLinksRequestSchema`）。 */
export const MAX_LINKS = 64;

/** 内容引用在链接文档里的 `kind`（Runtime 的 `collab/context_link.rs`）。 */
export const SHAPE_KIND = "shape";

/** 一次导出最多重试几次；之后停在 `error`，等显式重试。 */
export const MAX_EXPORT_ATTEMPTS = 3;

/**
 * 白板对象类型 → 标题用的 i18n 键。
 *
 * `ContextLink.content.shapeType` 只是给用户看的提示，Runtime 不按它分支
 * （已核实 `read_shape` 只读 `text` / `png_path`）。
 */
export const CONTENT_TYPE_KEYS: Record<string, string> = {
  text: "content.text",
  shape: "content.geo",
  ink: "content.draw",
  image: "content.image",
  line: "content.line",
  group: "content.group",
  // 画框引用的清单里也会出现节点（`frame-reference.ts`），所以节点类型
  // 也在这张表里。
  terminal: "content.terminal",
  sticky: "content.note",
  editor: "content.editor",
  diff: "content.diff",
  files: "content.files",
  browser: "content.browser",
  automation: "content.automation",
  agentActivity: "content.agentActivity",
};

/**
 * 导出图的底色。
 *
 * 不用透明：Agent 那头多半是把 PNG 贴进别的文档或直接用看图工具打开，
 * 深色纸上的白墨迹落在白色背板上会整张看不见。底色跟着**画布纸张色**
 * 走（`whiteboard/scheme.ts` 的同一条判据）。
 */
export const RASTER_BACKGROUND: Record<ColorScheme, string> = {
  light: "#ffffff",
  dark: "#1a1a1a",
};

/** 按字节截断（Runtime 校验的是字节数）。 */
export function clampText(
  text: string,
  limit = MAX_CONTENT_TEXT_BYTES,
): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  // 流式解码会留住不完整的尾部码点，而不是吐出无效代理对或替换字符。
  return new TextDecoder().decode(bytes.subarray(0, Math.max(0, limit)), {
    stream: true,
  });
}

/** 链接的标题：文字取正文前 40 字，其余取类型名。 */
export function contentTitle(
  kind: string,
  text: string,
  label: (key: string) => string = t,
): string {
  if (kind === "text") {
    const line = text.trim().replace(/\s+/gu, " ");
    if (line) {
      const chars = Array.from(line);
      return chars.length > TITLE_MAX
        ? `${clampText(chars.slice(0, TITLE_MAX).join(""), 157)}…`
        : clampText(line, 160);
    }
  }
  return label(CONTENT_TYPE_KEYS[kind] ?? "content.shape");
}

/* --------------------------------- 文字 ----------------------------------- */

/**
 * 一个白板对象的可读文字。
 *
 * 只有两种对象带文字：`text` 的正文与 `shape` 的标签。墨迹、图片、直线
 * 没有文字，交给 Agent 的就只有一张图。
 */
export function itemText(item: Item): string {
  if (item.kind === "text") return item.text.trim();
  if (item.kind === "shape") return (item.label ?? "").trim();
  return "";
}

/**
 * 「这个对象还是不是上次导出的那个样子」。
 *
 * 就是对象自己的 JSON **去掉 `x` / `y`**（§2.5）：挪一下位置画出来一模一样，
 * 不值得再导一次。`w` / `h` 留着——缩放会改变栅格。图片对象的 `assetPath`
 * 也在里面，所以换了图签名就变。
 */
export function itemSignature(item: Item | null | undefined): string {
  if (!item) return "";
  const { x: _x, y: _y, ...rest } = item;
  return JSON.stringify(rest);
}

/* ------------------------------- 内容解析 --------------------------------- */

export interface ContentDeps {
  /** 栅格化后的 PNG → 工作区相对路径。 */
  exportPng(exportId: string, dataUrl: string): Promise<string>;
  /** 图片对象的 `assetPath` → 可加载的 URL（栅格化时要真的把图画进去）。 */
  resolveImage?(assetPath: string): string | null;
  scheme?: ColorScheme;
  label?(key: string, values?: Record<string, string | number>): string;
}

export interface ResolvedContent {
  title: string;
  content: NonNullable<ContextLink["content"]>;
}

/** `Blob` → `data:image/png;base64,…`（`exportPng` 只收这一种）。 */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // 分块拼接：一次 `String.fromCharCode(...bytes)` 会在几百 KB 的图上把
  // 参数栈打爆。
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

/**
 * 一个白板对象 → 链接文档里的那一条。
 *
 * 三条分流：
 *
 *  - `text`：只有正文，不导出 PNG（Agent 直接读字）。
 *  - `image` 且是受管资产：`pngPath` 直接给 `.armadra/assets/…` 的相对路径，
 *    字节已经在工作区里了，不重复导出。v2 的图片对象没有裁剪 / 翻转 /
 *    旋转，所以这条分流永远成立（旧引擎那三个例外随它一起没了）。
 *  - 其余：栅格化后上传，`pngPath` 用返回的 `relativePath`。
 */
export async function resolveContent(
  item: Item,
  contentId: string,
  deps: ContentDeps,
): Promise<ResolvedContent> {
  const text = itemText(item);
  const title = contentTitle(item.kind, text, deps.label ?? t);
  const content: NonNullable<ContextLink["content"]> = {};
  if (text) content.text = clampText(text);

  if (item.kind === "text") return { title, content };

  if (item.kind === "image") {
    const managed = assetIdOf(item.assetPath);
    if (managed) {
      content.pngPath = item.assetPath;
      return { title, content };
    }
  }

  const scheme = deps.scheme ?? "light";
  const blob = await rasterizeItems([item], {
    scale: 2,
    padding: 16,
    background: RASTER_BACKGROUND[scheme],
    scheme,
    resolveImage: deps.resolveImage,
  });
  content.pngPath = await deps.exportPng(contentId, await blobToDataUrl(blob));
  return { title, content };
}

/* ------------------------------ 来源的三个投影 ----------------------------- */

/**
 * 引用来源的三个投影：给 Runtime 的 `sourceShapeId` / `shapeType`、可读文字、
 * 变化签名。白板对象与 Frame 只在这三处不同，状态机的其余部分完全共用。
 */

/** `wb:<uuid>`（白板对象）或裸 uuid（Frame）。Runtime 只当它是一个提示串。 */
export function sourceShapeId(source: ReferenceSource): string {
  return source.kind === "item"
    ? toItemId(source.item.id)
    : source.frame.frame.id;
}

/** `ink` / `text` / `shape` / `image` / `line`，或 Frame 的 `group`。 */
export function sourceShapeType(source: ReferenceSource): string {
  return source.kind === "item" ? source.item.kind : "group";
}

/** 这个来源还是不是上次导出的那个样子（缓存键）。 */
export function sourceSignature(source: ReferenceSource): string {
  return source.kind === "item"
    ? itemSignature(source.item)
    : frameSignature(source.frame);
}

/** 交给 Agent 的可读文字：对象的正文 / 标签，Frame 的成员清单。 */
export function sourceText(
  source: ReferenceSource,
  label: (key: string, values?: Record<string, string | number>) => string = t,
): string {
  if (source.kind === "item") return itemText(source.item);
  const title = source.frame.frame.title;
  return frameSummaryText(
    source.frame,
    (kind) => label(CONTENT_TYPE_KEYS[kind] ?? "content.shape"),
    {
      empty: label("content.frameEmpty", { title }),
      header: label("content.frameSummary", { title }),
      line: (line) =>
        line.text
          ? label("content.frameLine", { kind: line.kind, text: line.text })
          : label("content.frameLineBare", { kind: line.kind }),
      more: (rest) => label("content.frameMore", { count: rest }),
    },
  );
}

/** 链接标题：对象按类型 / 正文，Frame 用它自己的标题。 */
export function sourceTitle(
  source: ReferenceSource,
  label: (key: string, values?: Record<string, string | number>) => string = t,
): string {
  if (source.kind === "item") {
    return contentTitle(source.item.kind, itemText(source.item), label);
  }
  const title = source.frame.frame.title.trim();
  return title ? clampText(title, 160) : label("content.group");
}

/**
 * 一个 Frame → 链接文档里的那一条。
 *
 * 文字是成员清单，图是**框里所有白板对象一起**栅格化出来的一张（节点画不
 * 出来——终端和编辑器的画面不在白板文档里），所以框里只有节点时就只有文字。
 */
export async function resolveFrameContent(
  frame: FrameSource,
  contentId: string,
  deps: ContentDeps,
): Promise<ResolvedContent> {
  const label = deps.label ?? t;
  const source: ReferenceSource = { kind: "frame", frame };
  const content: NonNullable<ContextLink["content"]> = {};
  const text = sourceText(source, label);
  if (text) content.text = clampText(text);
  if (frame.items.length === 0) {
    return { title: sourceTitle(source, label), content };
  }
  const scheme = deps.scheme ?? "light";
  const blob = await rasterizeItems(frame.items, {
    scale: 2,
    padding: 16,
    background: RASTER_BACKGROUND[scheme],
    scheme,
    resolveImage: deps.resolveImage,
  });
  content.pngPath = await deps.exportPng(contentId, await blobToDataUrl(blob));
  return { title: sourceTitle(source, label), content };
}

/** 两条来源共用的入口。 */
export function resolveSource(
  source: ReferenceSource,
  contentId: string,
  deps: ContentDeps,
): Promise<ResolvedContent> {
  return source.kind === "item"
    ? resolveContent(source.item, contentId, deps)
    : resolveFrameContent(source.frame, contentId, deps);
}

/* -------------------------------- 收集 ------------------------------------ */

/**
 * 一条引用的来源：一个白板对象，或一个 Frame（`frame-reference.ts`）。
 *
 * `whiteboard.references.itemId` 两种都存裸 uuid，靠「在 `items` 里还是在
 * `nodes` 里」区分——两张表的 id 都是 uuid，不会撞。
 */
export type ReferenceSource =
  | { kind: "item"; item: Item }
  | { kind: "frame"; frame: FrameSource };

export interface ContentDescriptor {
  /** `ContextLink.id`，也是 `.armadra/exports/<id>.png` 的文件名。 */
  contentId: string;
  nodeId: string;
  source: ReferenceSource;
}

/**
 * 白板上所有的内容引用。
 *
 * 指向已经删掉的对象的引用行在这里被跳过（`whiteboard.removeItems` 会连引用
 * 一起删，但远端灌进来的文档可能还带着）；节点是否存在由
 * `context-links.buildLinkDocuments` 把关——它只往终端节点的文档里塞。
 */
export function collectContentLinks(
  whiteboard: WhiteboardDoc,
  document: BoardDocument | null = null,
): ContentDescriptor[] {
  const items = new Map(whiteboard.items.map((item) => [item.id, item]));
  const found: ContentDescriptor[] = [];
  for (const reference of whiteboard.references) {
    const item = items.get(reference.itemId);
    if (item) {
      found.push({
        contentId: reference.id,
        nodeId: reference.nodeId,
        source: { kind: "item", item },
      });
      continue;
    }
    const frame = frameSource(document, whiteboard, reference.itemId);
    if (!frame) continue;
    found.push({
      contentId: reference.id,
      nodeId: reference.nodeId,
      source: { kind: "frame", frame },
    });
  }
  return found;
}

/** 终端节点 id → 它的内容引用。 */
export type ContentLinkMap = Record<string, ContextLink[]>;

const NO_LINKS: ContentLinkMap = {};

function sameMap(a: ContentLinkMap, b: ContentLinkMap): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 显式重试，桌面与 Web 的右键菜单共用。 */
export const REFRESH_CONTENT_EVENT = "armadra:refresh-content-references";

export function refreshContentReferences(): void {
  window.dispatchEvent(new Event(REFRESH_CONTENT_EVENT));
}

/** `content` 里与内容无关的那半边（每次都现算，不进缓存）。 */
function sourceContent(
  source: ReferenceSource,
  label: (key: string, values?: Record<string, string | number>) => string = t,
): NonNullable<ContextLink["content"]> {
  const text = sourceText(source, label);
  return {
    sourceShapeId: sourceShapeId(source),
    shapeType: sourceShapeType(source),
    ...(text
      ? {
          text: clampText(text),
          textTruncated:
            new TextEncoder().encode(text).length > MAX_CONTENT_TEXT_BYTES,
        }
      : {}),
  };
}

/**
 * 画布上的内容引用（含已经解析好的 `content`）。
 *
 * 订阅的是 `canvas-store.whiteboard`：引用行、对象内容、对象尺寸任一变化
 * 都会重新排一次导出。`document` 不订阅——节点标题变了不影响这份内容，
 * 而节点被删掉时 `buildLinkDocuments` 自然就不会给它建文档。
 */
export function useContentLinks(): ContentLinkMap {
  const workspaceId = useCanvasStore((state) => state.workspace?.id);
  const boardId = useCanvasStore((state) => state.document?.board.id);
  const [links, setLinks] = React.useState<ContentLinkMap>(NO_LINKS);

  React.useEffect(() => {
    setLinks((previous) => (sameMap(previous, NO_LINKS) ? previous : NO_LINKS));
    if (!workspaceId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let dirty = false;
    let previewQueued = false;
    const cache = new Map<string, { signature: string; link: ContextLink }>();
    const failures = new Map<string, { signature: string; attempts: number }>();
    const deps: ContentDeps = {
      exportPng: async (exportId, dataUrl) => {
        const response = await runtimeApi.exportPng(
          workspaceId,
          exportId,
          dataUrl,
        );
        return response.relativePath;
      },
      resolveImage: (path) => assetUrlFor(workspaceId, path),
    };
    const whiteboard = () => useCanvasStore.getState().whiteboard;
    const board = () => useCanvasStore.getState().document;
    const links = () => collectContentLinks(whiteboard(), board());

    const currentMap = (): ContentLinkMap => {
      const next: ContentLinkMap = {};
      for (const item of links()) {
        const signature = sourceSignature(item.source);
        const cached = cache.get(item.contentId);
        const failed = failures.get(item.contentId);
        const content = sourceContent(item.source);
        // 只有纯文字用不着导出图；Frame 一律要（它的图是成员合成的）。
        const instant =
          item.source.kind === "item" && item.source.item.kind === "text";
        const link =
          cached?.signature === signature
            ? cached.link
            : {
                id: item.contentId,
                title: sourceTitle(item.source),
                kind: SHAPE_KIND,
                content: {
                  ...content,
                  status: instant
                    ? ("ready" as const)
                    : failed?.signature === signature &&
                        failed.attempts >= MAX_EXPORT_ATTEMPTS
                      ? ("error" as const)
                      : ("pending" as const),
                },
              };
        (next[item.nodeId] ??= []).push(link);
      }
      return next;
    };

    const publishPreview = () => {
      if (disposed) return;
      const next = currentMap();
      setLinks((previous) => (sameMap(previous, next) ? previous : next));
    };

    /** 结果回来时这条引用还是原来那条吗（来源换了内容 / 引用被删）？ */
    const stillCurrent = (item: ContentDescriptor, signature: string) => {
      const current = links().find((row) => row.contentId === item.contentId);
      if (!current || current.nodeId !== item.nodeId) return false;
      if (sourceShapeId(current.source) !== sourceShapeId(item.source)) {
        return false;
      }
      return sourceSignature(current.source) === signature;
    };

    const run = async () => {
      timer = null;
      if (disposed) return;
      if (inFlight) {
        dirty = true;
        return;
      }
      inFlight = true;
      dirty = false;
      const descriptors = links();
      let retry = false;
      try {
        const alive = new Set(descriptors.map((item) => item.contentId));
        for (const key of cache.keys()) if (!alive.has(key)) cache.delete(key);
        for (const key of failures.keys())
          if (!alive.has(key)) failures.delete(key);
        for (const item of descriptors) {
          const signature = sourceSignature(item.source);
          if (cache.get(item.contentId)?.signature === signature) continue;
          const failure = failures.get(item.contentId);
          const attempts =
            failure?.signature === signature ? failure.attempts : 0;
          if (attempts >= MAX_EXPORT_ATTEMPTS) continue;
          try {
            const resolved = await resolveSource(item.source, item.contentId, {
              ...deps,
              scheme: canvasScheme(),
            });
            if (disposed || !stillCurrent(item, signature)) {
              dirty = true;
              break;
            }
            cache.set(item.contentId, {
              signature,
              link: {
                id: item.contentId,
                title: resolved.title,
                kind: SHAPE_KIND,
                content: {
                  ...sourceContent(item.source),
                  ...resolved.content,
                  status: "ready",
                },
              },
            });
            failures.delete(item.contentId);
          } catch {
            if (disposed || !stillCurrent(item, signature)) {
              dirty = true;
              break;
            }
            failures.set(item.contentId, { signature, attempts: attempts + 1 });
            retry ||= attempts + 1 < MAX_EXPORT_ATTEMPTS;
          }
        }
      } finally {
        inFlight = false;
        if (!disposed) {
          publishPreview();
          if (dirty || retry) schedule();
        }
      }
    };

    function schedule() {
      if (disposed) return;
      dirty = true;
      // 有截止时间的排期：不断的无关编辑不会把导出无限推后。
      if (timer === null)
        timer = setTimeout(() => {
          void run();
        }, EXPORT_DELAY_MS);
      if (!previewQueued) {
        previewQueued = true;
        queueMicrotask(() => {
          previewQueued = false;
          publishPreview();
        });
      }
    }

    const refresh = () => {
      cache.clear();
      failures.clear();
      schedule();
    };

    schedule();
    // Frame 引用的内容来自 `document`（成员节点、Frame 的框与标题），
    // 所以文档变了也要重排一次——白板对象那条路照旧只看 `whiteboard`。
    const off = useCanvasStore.subscribe((state, previous) => {
      if (
        state.whiteboard !== previous.whiteboard ||
        state.document !== previous.document
      ) {
        schedule();
      }
    });
    window.addEventListener(REFRESH_CONTENT_EVENT, refresh);
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      off();
      window.removeEventListener(REFRESH_CONTENT_EVENT, refresh);
    };
  }, [workspaceId, boardId]);

  return links;
}
