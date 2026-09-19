import { toast } from "sonner";
import {
  ASSET_MIME_TYPES,
  MAX_ASSET_BYTES,
  MAX_IMPORT_FILES,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_BATCH_BYTES,
  type ImportedFileInfo,
  type Position,
  type CanvasNodeType,
} from "@armadra/shared";
import { runtimeApi } from "../../api/client";
import { AssetTooLargeError, uploadAsset } from "../assets";
import { addItems } from "../whiteboard/store";
import { isMermaidFileName } from "../whiteboard/mermaid/detect";
import { openMermaidImport } from "../whiteboard/mermaid/open";
import { canEditCanvas, useCanvasOwnership } from "../../canvas-ownership";
import { viewportCentre } from "../interaction/pointer";
import { t } from "../../app/preferences-store";
import { useCanvasStore } from "../../store/canvas-store";
import {
  assertRelativeWorkspacePath,
  FileDragError,
  type WorkspaceDragEntry,
} from "../../files/workspace-drag";

/**
 * 外部内容分流（React Flow 计划 F27）。
 *
 * 规则表一条没变：**图片 → `wb.image` 白板对象**（字节走资产接口，白板
 * 文档里只留 `assetPath`），**文本 / URL → `wb.text`**（Markdown 也当纯
 * 文本）。剩下的 OS 文件才是节点：目录 → `files`，其余文件复制到工作区后
 * 创建 `editor`（二进制显示附件）。
 *
 * React Flow 不接管 drop / paste，所以两条入口都归我们自己：`os-drop.ts`
 * 的 `onDrop` 与它装的 `paste` 监听。
 *
 * SVG 一律先在本地栅格化成 PNG 再上传：`<img>` 里的 SVG 不执行脚本，所以
 * 画一遍再取像素是安全的，而把原始 SVG 存进工作区并由 Runtime 以
 * `image/svg+xml` 发回来就不是——那等于把一段可执行文档放进画布。
 */

/* ------------------------------ 纯分流函数 -------------------------------- */

/** 有真实路径时按扩展名认图片（OS 拖放只给路径，没有 MIME）。 */
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
export type FileRoute = "image" | "mermaid" | "file";

export function routeFile(file: { name: string; type: string }): FileRoute {
  if (IMAGE_MIME_TYPES.has(file.type)) return "image";
  if (!file.type && isImagePath(file.name)) return "image";
  // `.mmd` / `.mermaid` 的 MIME 在所有系统上都是空串或 `text/plain`，
  // 所以只能看扩展名（Mermaid 导入设计 §4.4）。放在图片判定之后，免得
  // 一个叫 `a.png.mmd` 的文件两边都命中。
  if (isMermaidFileName(file.name)) return "mermaid";
  return "file";
}

/**
 * OS 拖放给的真实路径走哪条路。目录 → `files` 节点，其余 → `editor` 节点。
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

/** 量不出自然尺寸时给的兜底（正方形，缩放上限内）。 */
const FALLBACK_IMAGE_SIZE: ImageBox = { w: 320, h: 320 };

/** 自然尺寸：解码一次拿宽高。解不开（坏文件、jsdom）时回 null。 */
export async function measureImage(source: Blob): Promise<ImageBox | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(source);
    const box = { w: bitmap.width, h: bitmap.height };
    bitmap.close?.();
    return box;
  } catch {
    return null;
  }
}

/**
 * SVG → PNG。
 *
 * 走 `<img>` 解码：SVG 在 `<img>` 里是脚本禁用的，所以这条路不会执行文件
 * 里的 `<script>`；画进画布再取 PNG 之后，进工作区的就只是像素。
 * 环境画不了（jsdom、没有 canvas）时原样返回，调用方仍然拿到一个文件。
 */
export async function rasterizeSvg(file: File): Promise<File> {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    return file;
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("svg decode failed"));
      element.src = url;
    });
    const size = imageShapeSize({
      w: image.naturalWidth || FALLBACK_IMAGE_SIZE.w,
      h: image.naturalHeight || FALLBACK_IMAGE_SIZE.h,
    });
    const canvas = document.createElement("canvas");
    canvas.width = size.w * 2;
    canvas.height = size.h * 2;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) return file;
    return new File([blob], `${baseName(file.name)}.png`, {
      type: "image/png",
    });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 图片 → `wb.image` 白板对象。
 *
 * 字节走 `assets.uploadAsset`（落到 `.armadra/assets/`，内容寻址），白板
 * 文档里只留 `assetPath`；自然尺寸解码一次量出来，再经 `imageShapeSize`
 * 等比缩到 800px 以内，一排的落点由 `layoutImages` 算。
 *
 * 一张失败不影响其余：上传报错只提示那一张的文件名，已经上传成功的照建。
 * 返回建出来的白板对象 id。
 */
export async function createImageShapes(
  files: readonly File[],
  point: Position,
  target: ImportTarget | null = captureImportTarget(),
): Promise<string[]> {
  if (!target || files.length === 0) return [];
  const uploaded: { path: string; size: ImageBox; alt: string }[] = [];
  for (const original of files) {
    if (!importTargetIsActive(target)) return [];
    const file =
      original.type === "image/svg+xml" || extensionOf(original.name) === "svg"
        ? await rasterizeSvg(original)
        : original;
    const natural = (await measureImage(file)) ?? FALLBACK_IMAGE_SIZE;
    try {
      const path = await uploadAsset(target.workspaceId, file);
      uploaded.push({
        path,
        size: imageShapeSize(natural),
        alt: baseName(original.name),
      });
    } catch (cause) {
      // 超限时 `uploadAsset` 已经提示过一次了，别再刷第二条。
      if (!(cause instanceof AssetTooLargeError)) {
        toast.error(t("canvas.assetFailed", { name: baseName(original.name) }));
      }
    }
  }
  if (uploaded.length === 0 || !importTargetIsActive(target)) return [];
  const points = layoutImages(
    uploaded.map((entry) => entry.size),
    point,
  );
  return addItems(
    uploaded.map((entry, index) => ({
      id: crypto.randomUUID(),
      kind: "image" as const,
      x: points[index]!.x,
      y: points[index]!.y,
      w: entry.size.w,
      h: entry.size.h,
      z: 0,
      parentId: null,
      style: { color: "black" as const, size: "m" as const },
      assetPath: entry.path,
      alt: entry.alt,
    })),
  );
}

/* ------------------------------- 节点落地 --------------------------------- */

/**
 * OS 真实路径 → 节点。目录能被 Runtime 列出来，所以「是不是目录」问 Runtime，
 * 不用扩展名猜（沿用 v3 的 `os-drop` 规则）。
 */
export interface ImportTarget {
  workspaceId: string;
  boardId: string;
}

export function captureImportTarget(): ImportTarget | null {
  const state = useCanvasStore.getState();
  if (!state.workspace || !state.document) return null;
  return {
    workspaceId: state.workspace.id,
    boardId: state.document.board.id,
  };
}

/**
 * 这次导入的目标还是当初那块画布吗？
 *
 * 三件事一起看：工作空间没换、画布没换、这块画布现在能写。最后一条以前
 * 问的是 `editor.getIsReadonly()`，现在问归属网关（F36）——只读态由它决定。
 */
export function importTargetIsActive(target: ImportTarget): boolean {
  const state = useCanvasStore.getState();
  return (
    state.workspace?.id === target.workspaceId &&
    state.document?.board.id === target.boardId &&
    canEditCanvas(useCanvasOwnership.getState().status)
  );
}

function addImportedNode(
  target: ImportTarget,
  file: ImportedFileInfo,
  position: Position,
) {
  if (!importTargetIsActive(target)) return;
  useCanvasStore.getState().addNode("editor", {
    position,
    title: file.name,
    data: { kind: "editor", path: file.path },
  });
}

export async function addNodeForPath(
  path: string,
  position: Position,
): Promise<void> {
  await addNodesForPaths([path], position);
}

/** App file trees already identify the workspace and file kind. Keep those
 * references in-place; failures never fall back to copying some external path. */
export async function addWorkspaceEntriesToCanvas(
  entries: readonly WorkspaceDragEntry[],
  position: Position,
  target: ImportTarget | null = captureImportTarget(),
): Promise<void> {
  if (!target || !importTargetIsActive(target))
    throw new FileDragError("fileDrag.destinationChanged");
  if (!entries.length || entries.length > MAX_IMPORT_FILES)
    throw new FileDragError("fileDrag.invalidPayload");
  for (const [index, entry] of entries.entries()) {
    if (!importTargetIsActive(target)) return;
    assertRelativeWorkspacePath(entry.path);
    const point = offsetBy(position, index);
    if (entry.kind === "directory") {
      const directory = await runtimeApi.listFiles(
        target.workspaceId,
        entry.path,
      );
      assertRelativeWorkspacePath(directory.path, true);
      if (importTargetIsActive(target))
        useCanvasStore.getState().addNode("files", {
          position: point,
          title: entry.name,
          data: { kind: "files", path: directory.path },
        });
    } else if (isImagePath(entry.path)) {
      await importImageShape(target.workspaceId, entry.path, point, target);
    } else {
      const info = await runtimeApi.fileInfo(target.workspaceId, entry.path);
      assertRelativeWorkspacePath(info.path);
      addImportedNode(target, info, point);
    }
  }
}

export async function addNodesForPaths(
  paths: readonly string[],
  position: Position,
): Promise<void> {
  const target = captureImportTarget();
  if (!target) return;
  if (paths.length > MAX_IMPORT_FILES) {
    toast.error(t("canvas.importLimit"));
    return;
  }
  const external: { path: string; position: Position }[] = [];
  for (const [index, path] of paths.entries()) {
    if (!importTargetIsActive(target)) return;
    const point = offsetBy(position, index);
    if (isImagePath(path)) {
      await importImageShape(target.workspaceId, path, point, target);
      continue;
    }
    try {
      const info = await runtimeApi.fileInfo(target.workspaceId, path);
      addImportedNode(target, info, point);
    } catch {
      // Only an actual successful directory listing makes this a files node.
      // Permission errors must never masquerade as a file-type test.
      const directory = await runtimeApi
        .listFiles(target.workspaceId, path)
        .catch(() => null);
      if (directory) {
        if (importTargetIsActive(target))
          useCanvasStore.getState().addNode("files", {
            position: point,
            title: baseName(path),
            data: { kind: "files", path: directory.path },
          });
      } else external.push({ path, position: point });
    }
  }
  if (!external.length || !importTargetIsActive(target)) return;
  try {
    const result = await runtimeApi.importLocalFiles(
      target.workspaceId,
      external.map((entry) => entry.path),
    );
    result.files.forEach((file, index) =>
      addImportedNode(target, file, external[index]!.position),
    );
    if (!importTargetIsActive(target)) toast.info(t("canvas.importSaved"));
  } catch (cause) {
    toast.error(t("canvas.importFailed"), {
      description: (cause as Error).message,
    });
  }
}

/** Browser paths are names relative to an imported copy, never local paths. */
export async function addBrowserFiles(
  files: readonly File[],
  point: Position,
  target: ImportTarget | null = captureImportTarget(),
): Promise<void> {
  if (!target || !importTargetIsActive(target)) return;
  if (
    files.length > MAX_IMPORT_FILES ||
    files.some((file) => file.size > MAX_IMPORT_FILE_BYTES) ||
    files.reduce((sum, file) => sum + file.size, 0) > MAX_IMPORT_BATCH_BYTES
  ) {
    toast.error(t("canvas.importLimit"));
    return;
  }
  const images = files.filter((file) => routeFile(file) === "image");
  const diagrams = files.filter((file) => routeFile(file) === "mermaid");
  const others = files.filter((file) => routeFile(file) === "file");
  if (images.length) await createImageShapes(images, point, target);
  // 对话框一次只确认一张图，所以多个 `.mmd` 一起拖进来时只开第一个，
  // 其余按普通文件导入（设计 §4.4）。
  const [diagram, ...extraDiagrams] = diagrams;
  if (diagram) await openMermaidFile(diagram, point);
  others.push(...extraDiagrams);
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
    result.files.forEach((file, index) =>
      addImportedNode(target, file, offsetBy(point, index + images.length)),
    );
    if (!importTargetIsActive(target)) toast.info(t("canvas.importSaved"));
  } catch (cause) {
    toast.error(t("canvas.importFailed"), {
      description: (cause as Error).message,
    });
  }
}

/** A keyboard/touch-friendly alternative to drag-and-drop, reusable by menus. */
export function pickFilesForCanvas(point?: Position): void {
  const target = captureImportTarget();
  if (!target) return;
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.hidden = true;
  const position = point ?? viewportCentre();
  input.addEventListener(
    "change",
    () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      void addBrowserFiles(files, position, target);
    },
    { once: true },
  );
  input.addEventListener("cancel", () => input.remove(), { once: true });
  document.body.append(input);
  input.click();
}

/**
 * 磁盘上的图片 → `wb.image` 白板对象（桌面端 OS 拖放专用）。
 *
 * webview 收不到 `DataTransfer`，壳里也没有 fs 插件，所以字节只能由 Runtime
 * 读：`importAsset` 把文件复制进 `.armadra/assets/`（内容寻址，同一张图只落
 * 一份），路径直接写进白板对象，不必再取回来重传一遍。
 *
 * 自然尺寸得回头取一次（Runtime 不返回宽高）：取不回来就按兜底尺寸落，
 * 图仍然在画布上，用户拖一下把手就好，比整张丢掉强。
 */
async function importImageShape(
  workspaceId: string,
  path: string,
  position: Position,
  target: ImportTarget,
): Promise<void> {
  let asset: { id: string; path: string };
  try {
    asset = await runtimeApi.importAsset(workspaceId, path);
  } catch (cause) {
    toast.error(t("canvas.assetFailed", { name: baseName(path) }));
    void cause;
    return;
  }
  if (!importTargetIsActive(target)) return;
  const natural =
    (await fetchImageSize(runtimeApi.assetUrl(workspaceId, asset.id))) ??
    FALLBACK_IMAGE_SIZE;
  if (!importTargetIsActive(target)) return;
  const size = imageShapeSize(natural);
  addItems([
    {
      id: crypto.randomUUID(),
      kind: "image",
      x: position.x - size.w / 2,
      y: position.y - size.h / 2,
      w: size.w,
      h: size.h,
      z: 0,
      parentId: null,
      style: { color: "black", size: "m" },
      assetPath: asset.path,
      alt: baseName(path),
    },
  ]);
}

async function fetchImageSize(url: string): Promise<ImageBox | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await measureImage(await response.blob());
  } catch {
    return null;
  }
}

/**
 * 拖进来的 `.mmd` → 打开导入对话框（预填文件内容）。
 *
 * 和粘贴一样先确认再落地：文件里可能是半成品，直接画上去没法撤回到
 * 「什么都没发生」。读不出来时只提示，不退化成建一个 editor 节点——
 * 用户拖的是图，给他一个文本编辑器是答非所问。
 */
async function openMermaidFile(file: File, at: Position): Promise<void> {
  try {
    const text = await file.text();
    if (text.trim()) openMermaidImport({ text, at });
  } catch {
    toast.error(t("mermaid.fileFailed"));
  }
}
