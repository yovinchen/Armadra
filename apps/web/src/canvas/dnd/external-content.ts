import { toast } from "sonner";
import {
  ASSET_MIME_TYPES,
  type Position,
  type CanvasNodeType,
} from "@armadra/shared";
import {
  createShapeId,
  defaultHandleExternalTextContent,
  type Editor,
  type TLAsset,
  type TLShapeId,
  type TLShapePartial,
} from "tldraw";

import { runtimeApi } from "../../api/client";
import { getEditor } from "../editor-context";
import { AssetTooLargeError } from "../assets";
import { t } from "../../app/preferences-store";
import { useCanvasStore } from "../../store/canvas-store";

/**
 * 外部内容分流（tldraw 计划 §4.5、§8 Phase 3 / content）。
 *
 * 用户 2026-09-04 定的两条：**图片一律 tldraw 原生 image shape**（字节走
 * §6.2 的资产接口，不进快照），**文本一律 tldraw 原生 text shape**（Markdown
 * 也当纯文本，不再生成便签）。剩下的 OS 文件才是节点：目录 → `files`，
 * 其余 → `editor`。
 *
 * tldraw 自己就监听画布的 `drop` 与文档的 `paste`，两条路最后都汇到
 * `editor.putExternalContent`，所以这里只要覆盖 `files` / `text` / `url` 三个
 * 处理器，拖放与粘贴就自动同规则。`svg-text` 保持 tldraw 默认（它本来就走
 * 资产仓库）。
 */

/* ------------------------------ 纯分流函数 -------------------------------- */

/** 有真实路径时按扩展名认图片（Tauri 的拖放只给路径，没有 MIME）。 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "svg",
]);

/** Runtime 认的 MIME 白名单（`ASSET_MIME_TYPES`）。 */
const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(ASSET_MIME_TYPES);

/** 图片 shape 的最大边（页面单位）；超过就等比缩到这个数。 */
export const MAX_IMAGE_DIMENSION = 800;

/** 一次拖入多张图时的水平间距。 */
export const IMAGE_GAP = 16;

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function extensionOf(nameOrPath: string): string {
  const name = baseName(nameOrPath).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}

/**
 * 浏览器给的 `File` 走哪条路。
 *
 * MIME 优先（`image/png`…），拿不到 MIME 的时候退回扩展名——某些系统拖出来的
 * 文件 `type` 是空串。不是图片就当文本读，因为浏览器里的 `File` 没有真实路径，
 * 开不了 `editor` 节点。
 */
export type FileRoute = "image" | "text";

export function routeFile(file: { name: string; type: string }): FileRoute {
  if (IMAGE_MIME_TYPES.has(file.type)) return "image";
  if (!file.type && isImagePath(file.name)) return "image";
  return "text";
}

/**
 * Tauri 给的真实路径走哪条路。目录 → `files` 节点，其余 → `editor` 节点。
 *
 * 图片不走这里：它们在 `addNodeForPath` 里被 `importAsset` 截胡，变成 image
 * shape（§8 Phase 3 / asset-import）。
 */
export type PathRoute = Extract<CanvasNodeType, "files" | "editor">;

export function routePath(isDirectory: boolean): PathRoute {
  return isDirectory ? "files" : "editor";
}

export interface ImageBox {
  w: number;
  h: number;
}

/** 自然尺寸 → shape 尺寸：最大边不超过 `max`，比例不变。 */
export function imageShapeSize(
  natural: ImageBox,
  max: number = MAX_IMAGE_DIMENSION,
): ImageBox {
  const longest = Math.max(natural.w, natural.h);
  if (!Number.isFinite(longest) || longest <= 0) return { w: max, h: max };
  if (longest <= max) return { w: natural.w, h: natural.h };
  const scale = max / longest;
  return {
    w: Math.max(Math.round(natural.w * scale), 1),
    h: Math.max(Math.round(natural.h * scale), 1),
  };
}

/** 一排图片的左上角坐标：整排水平居中在 `point` 上。 */
export function layoutImages(
  sizes: readonly ImageBox[],
  point: Position,
): Position[] {
  if (sizes.length === 0) return [];
  const total =
    sizes.reduce((sum, size) => sum + size.w, 0) +
    IMAGE_GAP * (sizes.length - 1);
  let x = point.x - total / 2;
  return sizes.map((size) => {
    const at = { x, y: point.y - size.h / 2 };
    x += size.w + IMAGE_GAP;
    return at;
  });
}

/** 拖入的每个节点之间错开一点，免得完全重叠。 */
export function offsetBy(position: Position, index: number): Position {
  return { x: position.x + index * 28, y: position.y + index * 28 };
}

/* ------------------------------- 图片落地 --------------------------------- */

/**
 * 图片 → image shape。
 *
 * `getAssetForExternalContent` 会走 tldraw 默认的 file 资产处理器，它调
 * `editor.uploadAsset`，也就是我们挂在 `<Tldraw assets>` 上的
 * `createAssetStore`——字节最终落到 Runtime 的 `.armadra/assets/`，
 * 记录里只留 URL 与 `meta.armadra.path`。
 */
export async function createImageShapes(
  editor: Editor,
  files: readonly File[],
  point: Position,
): Promise<TLShapeId[]> {
  const assets: TLAsset[] = [];
  for (const file of files) {
    try {
      const asset = await editor.getAssetForExternalContent({
        type: "file",
        file,
      });
      if (asset) assets.push(asset);
    } catch (cause) {
      // 超限时资产仓库已经提示过了，别再叠一条泛泛的「上传失败」。
      if (cause instanceof AssetTooLargeError) continue;
      console.error("asset upload failed", cause);
      toast.error(t("canvas.assetFailed", { name: file.name }));
    }
  }
  if (assets.length === 0) return [];

  const sizes = assets.map((asset) =>
    imageShapeSize({
      w: Number((asset.props as { w?: number }).w) || MAX_IMAGE_DIMENSION,
      h: Number((asset.props as { h?: number }).h) || MAX_IMAGE_DIMENSION,
    }),
  );
  const points = layoutImages(sizes, point);

  const partials: TLShapePartial[] = assets.map((asset, index) => ({
    id: createShapeId(),
    type: "image",
    x: points[index]!.x,
    y: points[index]!.y,
    props: {
      w: sizes[index]!.w,
      h: sizes[index]!.h,
      assetId: asset.id,
    },
  }));

  editor.run(() => {
    const missing = assets.filter((asset) => !editor.getAsset(asset.id));
    if (missing.length > 0) editor.createAssets(missing);
    editor.createShapes(partials);
    // 页面满了的时候 `createShapes` 什么都不建也不报错，所以选中之前先确认。
    const created = partials
      .map((partial) => partial.id)
      .filter((id) => Boolean(editor.getShape(id)));
    if (created.length > 0) editor.select(...created);
  });

  return partials.map((partial) => partial.id);
}

/* ------------------------------- 节点落地 --------------------------------- */

/**
 * OS 真实路径 → 节点。目录能被 Runtime 列出来，所以「是不是目录」问 Runtime，
 * 不用扩展名猜（沿用 v3 的 `os-drop` 规则）。
 */
export async function addNodeForPath(
  path: string,
  position: Position,
): Promise<void> {
  const store = useCanvasStore.getState();
  if (!store.document) return;
  const workspace = store.workspace;
  const title = baseName(path);

  // 图片先截胡：桌面端只拿得到路径，让 Runtime 去读盘导入，然后和浏览器拖放
  // 走同一条 image shape 的路（§8 Phase 3 / asset-import）。
  const editor = getEditor();
  if (editor && workspace && isImagePath(path)) {
    await importImageShape(editor, workspace.id, path, position);
    return;
  }

  let directory = false;
  if (workspace) {
    directory = await runtimeApi
      .listFiles(workspace.id, path)
      .then(() => true)
      .catch(() => false);
  }

  const type = routePath(directory);
  useCanvasStore.getState().addNode(type, {
    position,
    title,
    data: type === "files" ? { kind: "files", path } : { kind: "editor", path },
  });
}

export async function addNodesForPaths(
  paths: readonly string[],
  position: Position,
): Promise<void> {
  for (const [index, path] of paths.entries()) {
    await addNodeForPath(path, offsetBy(position, index));
  }
}

/**
 * 磁盘上的图片 → image shape（桌面端 OS 拖放专用）。
 *
 * webview 收不到 `DataTransfer`，壳里也没有 fs 插件，所以字节只能由 Runtime
 * 读：`importAsset` 把文件复制进 `.armadra/assets/`（内容寻址，同一张图只落一
 * 份），再取回来包成 `File` 交给 `createImageShapes`——这样尺寸、`meta.armadra.path`
 * 和浏览器那条路完全同规则。取回时的那次重传只在 loopback 上发生，重新上传
 * 的哈希相同，Runtime 认得出来不会再写盘。
 */
async function importImageShape(
  editor: Editor,
  workspaceId: string,
  path: string,
  position: Position,
): Promise<void> {
  const name = baseName(path);
  try {
    const imported = await runtimeApi.importAsset(workspaceId, path);
    const response = await fetch(runtimeApi.assetUrl(workspaceId, imported.id));
    if (!response.ok) throw new Error(`asset ${response.status}`);
    const file = new File([await response.blob()], name, {
      type: imported.mimeType,
    });
    await createImageShapes(editor, [file], position);
  } catch (cause) {
    console.error("asset import failed", cause);
    toast.error(t("canvas.assetFailed", { name }));
  }
}

/* ---------------------------- 处理器注册 ---------------------------------- */

/** 没有指针位置时的落点（粘贴走这条）。 */
function fallbackPoint(editor: Editor): Position {
  const center = editor.getViewportPageBounds().center;
  return { x: center.x, y: center.y };
}

async function readText(file: File): Promise<string> {
  return file.text().catch(() => "");
}

/**
 * 覆盖 `files` 与 `text` 两个外部内容处理器；返回注销函数。
 *
 * `registerExternalContentHandler(type, null)` 就是注销，所以卸载时把两个
 * 都置 null——`<Tldraw>` 重新挂载时会重新装一遍它自己的默认实现。
 */
export function registerExternalContent(editor: Editor): () => void {
  editor.registerExternalContentHandler("files", async (content) => {
    const point = content.point
      ? { x: content.point.x, y: content.point.y }
      : fallbackPoint(editor);

    const images: File[] = [];
    const others: File[] = [];
    for (const file of content.files) {
      if (routeFile(file) === "image") images.push(file);
      else others.push(file);
    }

    if (images.length > 0) await createImageShapes(editor, images, point);

    // 浏览器里的 `File` 没有真实路径，开不了 `editor` 节点，只能把内容当文本。
    for (const file of others) {
      const text = await readText(file);
      if (!text.trim()) continue;
      await editor.putExternalContent({ type: "text", text, point });
    }
  });

  // 文本一律纯文本：把 `html` 丢掉，Markdown 也就只是一段字。
  editor.registerExternalContentHandler("text", async (content) => {
    await defaultHandleExternalTextContent(editor, {
      point: content.point,
      text: content.text,
    });
  });

  /*
   * URL 也是一段字。tldraw 默认会开一个 bookmark（或可嵌入站点的 embed）
   * shape，而这两种在 §4.5 里已经停用——`shapes/retired-shapes.ts`。
   */
  editor.registerExternalContentHandler("url", async (content) => {
    await defaultHandleExternalTextContent(editor, {
      point: content.point,
      text: content.url,
    });
  });

  return () => {
    editor.registerExternalContentHandler("files", null);
    editor.registerExternalContentHandler("text", null);
    editor.registerExternalContentHandler("url", null);
  };
}
