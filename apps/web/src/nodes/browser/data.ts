import { clearAllBrowserHistory } from "./history";

/**
 * 清理浏览器节点的浏览数据：壳里清掉那一族 partition 的 cookie、存储与缓存
 * （`browser:clear-data`），页面这边清掉各工作空间的地址历史。
 *
 * 返回清理是否完整。壳不在时没有 partition 可清，只清历史，算成功。
 * `workspaceIds` 是页面知道的工作空间：本次启动才建、还没落过盘的
 * partition 靠它补上（主进程另外会扫磁盘）。
 */
export async function clearBrowsingData(
  workspaceIds: readonly string[],
): Promise<boolean> {
  clearAllBrowserHistory();
  const shell = typeof window === "undefined" ? undefined : window.armadra;
  if (!shell) return true;
  try {
    const result = await shell.browser.clearData({ workspaceIds });
    return result.ok;
  } catch (cause) {
    console.error("clearing browsing data failed", cause);
    return false;
  }
}
