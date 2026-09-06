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
import { canEditCanvas, useCanvasOwnership } from "../../canvas-ownership";
import { containerSize, getFlow } from "../flow/flow-context";
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
 * **B2 重建图片与文字那两条分支**：它们要建白板对象，而白板层还没有。
 * B0 保留全部纯分流函数与节点落地（目录 / 文件 → 节点），那部分不依赖
 * 白板，拖一个目录进画布现在就能用。
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
 * 图片 → `wb.image` 白板对象。**B2 重建。**
 *
 * 字节走 `assets.uploadAsset`（落到 `.armadra/assets/`，内容寻址），白板
 * 文档里只留 `assetPath`；自然尺寸用 `createImageBitmap` 量，再经
 * `imageShapeSize` 等比缩到 800px 以内，一排的落点由 `layoutImages` 算。
 * SVG 一律先栅格化成 PNG 再上传（B2 决定：规避内联脚本）。
 *
 * 返回建出来的白板对象 id；B0 恒为空数组。
 */
export async function createImageShapes(
  _files: readonly File[],
  _point: Position,
  _target: ImportTarget | null = captureImportTarget(),
): Promise<string[]> {
  return [];
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
  const others = files.filter((file) => routeFile(file) === "file");
  if (images.length) await createImageShapes(images, point, target);
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
 * 磁盘上的图片 → `wb.image` 白板对象（桌面端 OS 拖放专用）。**B2 重建。**
 *
 * webview 收不到 `DataTransfer`，壳里也没有 fs 插件，所以字节只能由 Runtime
 * 读：`importAsset` 把文件复制进 `.armadra/assets/`（内容寻址，同一张图只落
 * 一份），路径直接写进白板对象，不必再取回来重传一遍。
 */
async function importImageShape(
  _workspaceId: string,
  _path: string,
  _position: Position,
  _target: ImportTarget,
): Promise<void> {
  // B2: runtimeApi.importAsset -> whiteboard.addItems([{ kind: "image" }])
}

/** 没有指针位置时的落点（粘贴走这条）：视口中心的画布坐标。 */
function viewportCentre(): Position {
  const flow = getFlow();
  const { width, height } = containerSize();
  if (!flow || width <= 0) return { x: 0, y: 0 };
  return flow.screenToFlowPosition({ x: width / 2, y: height / 2 });
}
