import { toast } from "sonner";
import {
  ASSET_MIME_TYPES,
  MAX_ASSET_BYTES,
  MAX_IMPORT_FILES, MAX_IMPORT_FILE_BYTES, MAX_IMPORT_BATCH_BYTES,
  type ImportedFileInfo,
  type Position,
  type CanvasNodeType,
} from "@armadra/shared";
import {
  createShapeId,
  AssetRecordType,
  getAssetInfo,
  sanitizeSvg,
  defaultHandleExternalTextContent,
  type Editor,
  type TLAsset,
  type TLShapeId,
  type TLShapePartial,
} from "tldraw";

import { runtimeApi } from "../../api/client";
import { getEditor } from "../editor-context";
import { AssetTooLargeError, createAssetStore } from "../assets";
import { t } from "../../app/preferences-store";
import { useCanvasStore } from "../../store/canvas-store";
import {
  assertRelativeWorkspacePath,
  FileDragError,
  type WorkspaceDragEntry,
} from "../../files/workspace-drag";

/**
 * 外部内容分流（tldraw 计划 §4.5、§8 Phase 3 / content）。
 *
 * 用户 2026-09-04 定的两条：**图片一律 tldraw 原生 image shape**（字节走
 * §6.2 的资产接口，不进快照），**文本一律 tldraw 原生 text shape**（Markdown
 * 也当纯文本，不再生成便签）。剩下的 OS 文件才是节点：目录 → `files`，
 * 其余文件复制到工作区后创建 `editor`（二进制显示附件）。
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
 * 文件 `type` 是空串。非图片按字节上传为导入副本，绝不以文件名伪造本机路径。
 */
export type FileRoute = "image" | "file";

export function routeFile(file: { name: string; type: string }): FileRoute {
  if (IMAGE_MIME_TYPES.has(file.type)) return "image";
  if (!file.type && isImagePath(file.name)) return "image";
  return "file";
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
  target: ImportTarget | null = captureImportTarget(),
): Promise<TLShapeId[]> {
  const assets: TLAsset[] = [];
  for (const file of files) {
    if (target && !importTargetIsActive(target)) return [];
    try {
      if (file.size > MAX_ASSET_BYTES) {
        toast.error(t("canvas.assetTooLarge", { limit: Math.round(MAX_ASSET_BYTES / 1024 / 1024) }));
        throw new AssetTooLargeError();
      }
      // Keep tldraw's dimensions/hash/animation metadata and SVG sanitation,
      // but bind uploads to the workspace captured at the start of the drop.
      // The global asset store otherwise follows workspace switches mid-decode.
      const mimes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml" };
      let safeFile = file.type ? file : new File([file], file.name, { type: mimes[extensionOf(file.name)] ?? "" });
      if (safeFile.type === "image/svg+xml") {
        const sanitized = sanitizeSvg(await safeFile.text());
        if (!sanitized) throw new Error("SVG contains no safe image content");
        safeFile = new File([sanitized], safeFile.name, { type: safeFile.type });
      }
      const info = await getAssetInfo(editor, safeFile);
      if (!info) throw new Error("Unsupported image format");
      if (!target || !importTargetIsActive(target)) return [];
      const asset = AssetRecordType.create(info);
      const uploaded = await createAssetStore(() => target.workspaceId).upload(asset, safeFile);
      asset.props.src = uploaded.src;
      if (uploaded.meta) asset.meta = { ...asset.meta, ...uploaded.meta };
      if (asset) assets.push(asset);
    } catch (cause) {
      // 超限时资产仓库已经提示过了，别再叠一条泛泛的「上传失败」。
      if (cause instanceof AssetTooLargeError) continue;
      console.error("asset upload failed", cause);
      toast.error(t("canvas.assetFailed", { name: file.name }));
    }
  }
  if (assets.length === 0 || (target && !importTargetIsActive(target))) return [];

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
export interface ImportTarget {
  workspaceId: string;
  boardId: string;
  editor: Editor | null;
}

export function captureImportTarget(): ImportTarget | null {
  const state = useCanvasStore.getState();
  if (!state.workspace || !state.document) return null;
  return { workspaceId: state.workspace.id, boardId: state.document.board.id, editor: getEditor() };
}

export function importTargetIsActive(target: ImportTarget): boolean {
  const state = useCanvasStore.getState();
  return (
    state.workspace?.id === target.workspaceId &&
    state.document?.board.id === target.boardId &&
    getEditor() === target.editor &&
    target.editor?.getIsReadonly?.() !== true
  );
}

function addImportedNode(target: ImportTarget, file: ImportedFileInfo, position: Position) {
  if (!importTargetIsActive(target)) return;
  useCanvasStore.getState().addNode("editor", {
    position, title: file.name, data: { kind: "editor", path: file.path },
  });
}

export async function addNodeForPath(path: string, position: Position): Promise<void> {
  await addNodesForPaths([path], position);
}

/** App file trees already identify the workspace and file kind. Keep those
 * references in-place; failures never fall back to copying some external path. */
export async function addWorkspaceEntriesToCanvas(
  entries: readonly WorkspaceDragEntry[], position: Position,
  target: ImportTarget | null = captureImportTarget(),
): Promise<void> {
  if (!target || !importTargetIsActive(target)) throw new FileDragError("fileDrag.destinationChanged");
  if (!entries.length || entries.length > MAX_IMPORT_FILES) throw new FileDragError("fileDrag.invalidPayload");
  for (const [index, entry] of entries.entries()) {
    if (!importTargetIsActive(target)) return;
    assertRelativeWorkspacePath(entry.path);
    const point = offsetBy(position, index);
    if (entry.kind === "directory") {
      const directory = await runtimeApi.listFiles(target.workspaceId, entry.path);
      assertRelativeWorkspacePath(directory.path, true);
      if (importTargetIsActive(target)) useCanvasStore.getState().addNode("files", {
        position: point, title: entry.name, data: { kind: "files", path: directory.path },
      });
    } else if (target.editor && isImagePath(entry.path)) {
      await importImageShape(target.editor, target.workspaceId, entry.path, point, target);
    } else {
      const info = await runtimeApi.fileInfo(target.workspaceId, entry.path);
      assertRelativeWorkspacePath(info.path);
      addImportedNode(target, info, point);
    }
  }
}

export async function addNodesForPaths(paths: readonly string[], position: Position): Promise<void> {
  const target = captureImportTarget();
  if (!target) return;
  if (paths.length > MAX_IMPORT_FILES) { toast.error(t("canvas.importLimit")); return; }
  const external: { path: string; position: Position }[] = [];
  for (const [index, path] of paths.entries()) {
    if (!importTargetIsActive(target)) return;
    const point = offsetBy(position, index);
    if (target.editor && isImagePath(path)) {
      await importImageShape(target.editor, target.workspaceId, path, point, target);
      continue;
    }
    try {
      const info = await runtimeApi.fileInfo(target.workspaceId, path);
      addImportedNode(target, info, point);
    } catch {
      // Only an actual successful directory listing makes this a files node.
      // Permission errors must never masquerade as a file-type test.
      const directory = await runtimeApi.listFiles(target.workspaceId, path).catch(() => null);
      if (directory) {
        if (importTargetIsActive(target)) useCanvasStore.getState().addNode("files", {
          position: point, title: baseName(path), data: { kind: "files", path: directory.path },
        });
      } else external.push({ path, position: point });
    }
  }
  if (!external.length || !importTargetIsActive(target)) return;
  try {
    const result = await runtimeApi.importLocalFiles(target.workspaceId, external.map((entry) => entry.path));
    result.files.forEach((file, index) => addImportedNode(target, file, external[index]!.position));
    if (!importTargetIsActive(target)) toast.info(t("canvas.importSaved"));
  } catch (cause) {
    toast.error(t("canvas.importFailed"), { description: (cause as Error).message });
  }
}

/** Browser paths are names relative to an imported copy, never local paths. */
export async function addBrowserFiles(
  editor: Editor, files: readonly File[], point: Position,
  target: ImportTarget | null = captureImportTarget(),
): Promise<void> {
  if (!target || !importTargetIsActive(target)) return;
  if (files.length > MAX_IMPORT_FILES || files.some((file) => file.size > MAX_IMPORT_FILE_BYTES)
      || files.reduce((sum, file) => sum + file.size, 0) > MAX_IMPORT_BATCH_BYTES) {
    toast.error(t("canvas.importLimit")); return;
  }
  const images = files.filter((file) => routeFile(file) === "image");
  const others = files.filter((file) => routeFile(file) === "file");
  if (images.length) await createImageShapes(editor, images, point, target);
  if (!others.length || !importTargetIsActive(target)) return;
  // Repeated names get distinct paths without overwriting either file.
  const used = new Set<string>();
  const entries = others.map((file) => {
    let path = file.name;
    let index = 2;
    while (used.has(path)) path = `${index++}-${file.name}`;
    used.add(path);
    return { file, path };
  });
  try {
    const result = await runtimeApi.importFiles(target.workspaceId, entries);
    result.files.forEach((file, index) => addImportedNode(target, file, offsetBy(point, index + images.length)));
    if (!importTargetIsActive(target)) toast.info(t("canvas.importSaved"));
  } catch (cause) {
    toast.error(t("canvas.importFailed"), { description: (cause as Error).message });
  }
}

/** A keyboard/touch-friendly alternative to drag-and-drop, reusable by menus. */
export function pickFilesForCanvas(point?: Position): void {
  const target = captureImportTarget();
  const editor = target?.editor;
  if (!target || !editor) return;
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.hidden = true;
  const position = point ?? fallbackPoint(editor);
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    input.remove();
    void addBrowserFiles(editor, files, position, target);
  }, { once: true });
  input.addEventListener("cancel", () => input.remove(), { once: true });
  document.body.append(input);
  input.click();
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
  target: ImportTarget,
): Promise<void> {
  const name = baseName(path);
  try {
    const imported = await runtimeApi.importAsset(workspaceId, path);
    const response = await fetch(runtimeApi.assetUrl(workspaceId, imported.id));
    if (!response.ok) throw new Error(`asset ${response.status}`);
    const file = new File([await response.blob()], name, {
      type: imported.mimeType,
    });
    if (importTargetIsActive(target)) await createImageShapes(editor, [file], position, target);
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

    await addBrowserFiles(editor, content.files, point);
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
