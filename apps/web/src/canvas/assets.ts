import { toast } from "sonner";
import { MAX_ASSET_BYTES } from "@armadra/shared";

import { runtimeApi } from "../api/client";
import { t } from "../app/preferences-store";

/**
 * 白板资产（React Flow 计划 F26）。
 *
 * 字节落到 `<workspace>/.armadra/assets/<sha256 前 16 位>.<ext>`，白板文档里
 * 只留 `assetPath`（工作区相对路径）。显示 URL 由 `runtimeApi.assetUrl`
 * 现算——存下来的 localhost 地址可能指向上一次的 Runtime 端口。
 *
 * `assetPath` 也是内容引用交给 Agent 的东西（Agent 读的是文件，不是 URL），
 * 所以它必须是相对路径。
 *
 * 旧引擎的资产仓库接口没有了（B2 把上传接到拖放 / 粘贴 / Dock
 * 按钮上）；上传、限额与路径解析这三件事原样留在这里。
 */

/** 8 MiB —— 与 Runtime 的 `MAX_ASSET_BYTES` 同一个常量。 */
export const MAX_UPLOAD_BYTES = MAX_ASSET_BYTES;

/** 只用来拼提示语：8388608 → "8"。 */
export function megabytes(bytes: number): string {
  return String(Math.round(bytes / (1024 * 1024)));
}

/** 超限时抛这个：调用方靠它区分「已经提示过了」和真正的失败。 */
export class AssetTooLargeError extends Error {
  constructor() {
    super("asset too large");
    this.name = "AssetTooLargeError";
  }
}

/** 纯判断，给单测用。 */
export function withinUploadLimit(bytes: number): boolean {
  return bytes <= MAX_UPLOAD_BYTES;
}

const ASSET_PATH = /^\.armadra\/assets\/([a-f0-9]{16}\.[a-z0-9]+)$/i;

/** 从工作区相对路径里取回资产 id；不是资产路径就是 null。 */
export function assetIdOf(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.match(ASSET_PATH)?.[1] ?? null;
}

/** 白板图片对象的显示地址；工作区或路径不对时返回 null。 */
export function assetUrlFor(
  workspaceId: string | null,
  path: string | null | undefined,
): string | null {
  const id = assetIdOf(path);
  if (!workspaceId || !id) return null;
  return runtimeApi.assetUrl(workspaceId, id);
}

/**
 * 上传一个文件，返回它的工作区相对路径。
 *
 * 超限时提示一次并抛 `AssetTooLargeError`，调用方靠它区分「已经提示过了」
 * 和真正的失败。
 */
export async function uploadAsset(
  workspaceId: string,
  file: File,
): Promise<string> {
  if (!withinUploadLimit(file.size)) {
    toast.error(
      t("canvas.assetTooLarge", { limit: megabytes(MAX_UPLOAD_BYTES) }),
    );
    throw new AssetTooLargeError();
  }
  const uploaded = await runtimeApi.uploadAsset(workspaceId, file);
  return uploaded.path;
}
