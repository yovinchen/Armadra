import { toast } from "sonner";
import { MAX_ASSET_BYTES } from "@armadra/shared";
import type { TLAsset, TLAssetStore } from "tldraw";

import { runtimeApi } from "../api/client";
import { t } from "../app/preferences-store";

/**
 * 白板资产仓库（tldraw 计划 §6.2）。
 *
 * tldraw 默认把图片编成 data URL 塞进快照里，那条路会让 `boards.whiteboard_json`
 * 几张图就撞上 8 MiB 上限。这里把 `upload` 接到 Runtime 的资产接口上：字节落到
 * `<workspace>/.armadra/assets/<sha256 前 16 位>.<ext>`，快照里只留一个 Runtime URL。
 *
 * `meta.armadra.path` 存的是**工作区相对路径**，Phase 4 的内容链接直接把它交给
 * Agent（Agent 读的是文件，不是 URL），所以这里不能省。
 */

/** 每个资产写在 `meta.armadra` 下的东西。 */
export interface ArmadraAssetMeta {
  /** 工作区相对路径，形如 `.armadra/assets/0a1b….png`。 */
  path: string;
}

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

/** 从资产记录里取回工作区相对路径；没有就是 null（旧的 data URL 资产）。 */
export function assetPath(asset: Pick<TLAsset, "meta"> | undefined): string | null {
  const scope = asset?.meta?.["armadra"];
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const path = (scope as Record<string, unknown>)["path"];
  return typeof path === "string" && path.length > 0 ? path : null;
}

/**
 * 建一个 `TLAssetStore`。
 *
 * 工作区 id 用 getter 而不是值：`<Tldraw>` 只在挂载时读一次 `assets`，换工作区
 * 时并不会拿新的实例去重建 store，捕获成常量就会把新工作区的图写进旧工作区。
 */
export function createAssetStore(
  getWorkspaceId: () => string | null,
): TLAssetStore {
  return {
    async upload(_asset, file) {
      const workspaceId = getWorkspaceId();
      if (!workspaceId) throw new Error("no workspace");

      if (!withinUploadLimit(file.size)) {
        toast.error(
          t("canvas.assetTooLarge", { limit: megabytes(MAX_UPLOAD_BYTES) }),
        );
        throw new AssetTooLargeError();
      }

      const uploaded = await runtimeApi.uploadAsset(workspaceId, file);
      return {
        src: runtimeApi.assetUrl(workspaceId, uploaded.id),
        meta: { armadra: { path: uploaded.path } },
      };
    },

    /** 上传时存的已经是可直接加载的绝对地址，原样返回。 */
    resolve(asset) {
      const src = (asset.props as { src?: string | null }).src;
      return src ?? null;
    },
  };
}
