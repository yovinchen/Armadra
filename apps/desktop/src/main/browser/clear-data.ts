import { readdirSync } from "node:fs";
import type { Session } from "electron";

/**
 * 设置 → 浏览器 →「清理浏览数据」（editor-browser-design §5）。
 *
 * 浏览器节点的 cookie、存储与缓存都在 `persist:armadra-browser-<工作空间>` 这些
 * partition 里（`apps/web/src/nodes/browser/webview.ts` 的 `browserPartition`），
 * 所以清理的对象是这一族 partition，而不是应用自己的默认 session——那里是
 * Armadra 的界面，清了只会把人登出自己的应用。
 *
 * 哪些 partition 要清，两处来源取并集：
 *
 *   * 磁盘上 `<userData>/Partitions/armadra-browser-*` 的目录。删掉的工作空间
 *     节点没了，它的登录却还躺在这里，只有扫目录才找得到。
 *   * 页面报上来的工作空间 id。一个本次启动才建、还没落过盘的 partition，
 *     目录里还看不见。
 *
 * 只认这一族前缀，别的名字一律忽略：页面能传任意字符串，而这条通道做的事
 * 是删数据。
 */

export const BROWSER_PARTITION_PREFIX = "armadra-browser-";
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface ClearDataDeps {
  /** `<userData>/Partitions`。 */
  readonly partitionsDir: string;
  sessionFor(
    partition: string,
  ): Pick<Session, "clearStorageData" | "clearCache">;
  readDir?: (dir: string) => string[];
}

export interface ClearDataResult {
  readonly ok: boolean;
  /** 实际清过的 partition 数。 */
  readonly cleared: number;
}

export function browserPartitions(
  deps: Pick<ClearDataDeps, "partitionsDir" | "readDir">,
  workspaceIds: unknown,
): string[] {
  const names = new Set<string>();
  let entries: string[] = [];
  try {
    entries = (deps.readDir ?? ((dir) => readdirSync(dir)))(deps.partitionsDir);
  } catch {
    // 还没有任何持久 partition：目录不存在是正常的。
  }
  for (const entry of entries) {
    if (!entry.startsWith(BROWSER_PARTITION_PREFIX)) continue;
    const id = entry.slice(BROWSER_PARTITION_PREFIX.length);
    if (WORKSPACE_ID.test(id)) names.add(id);
  }
  if (Array.isArray(workspaceIds)) {
    for (const id of workspaceIds) {
      if (typeof id === "string" && WORKSPACE_ID.test(id)) names.add(id);
    }
  }
  return [...names]
    .sort()
    .map((id) => `persist:${BROWSER_PARTITION_PREFIX}${id}`);
}

export async function clearBrowsingData(
  deps: ClearDataDeps,
  request: unknown,
): Promise<ClearDataResult> {
  const workspaceIds = (request as { workspaceIds?: unknown } | undefined)
    ?.workspaceIds;
  const partitions = browserPartitions(deps, workspaceIds);
  let cleared = 0;
  let ok = true;
  for (const partition of partitions) {
    const target = deps.sessionFor(partition);
    try {
      // 存储（cookie、localStorage、IndexedDB、Service Worker…）和 HTTP 缓存
      // 是两个 API；只清前者，下次打开页面还会从缓存里拿到登录后的资源。
      await target.clearStorageData();
      await target.clearCache();
      cleared += 1;
    } catch {
      ok = false;
    }
  }
  return { ok, cleared };
}
