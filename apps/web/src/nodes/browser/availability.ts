import * as React from "react";
import { systemApi } from "@/api/system";
import { isDesktop } from "@/platform";

/**
 * 这个页面能不能建浏览器节点（typescript-core.md R6c）。
 *
 * 桌面壳里页面是窗口的一个 `<webview>` guest，总能建；非桌面环境要看 core：
 * 服务器壳起得了 headless Chromium 时，`/api/health` 的 `capabilities` 里
 * 会有 `headlessBrowser: true`，节点体走 `StreamSurface`。
 *
 * 只问一次：core 带不带浏览器是启动时就定下的，不会在页面开着时变。问不到
 * （旧 core、网络断了）按「没有」处理——少一个入口，比多一个建出来就报不可用
 * 的节点好。
 */

let headless = false;
let probe: Promise<void> | undefined;
const listeners = new Set<() => void>();

function ensureProbe(): void {
  if (probe !== undefined || isDesktop()) return;
  probe = systemApi
    .health()
    .then((health) => {
      headless = health.capabilities?.headlessBrowser === true;
    })
    .catch(() => {
      // 下一次挂载再问：一次网络抖动不该让入口一直藏着。
      probe = undefined;
    })
    .finally(() => {
      for (const listener of listeners) listener();
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): boolean {
  return headless;
}

/**
 * core 是否带 headless 浏览器。`enabled` 为假时不发请求，只读已知的答案——
 * 画布上每个节点头都会调它，不相关的节点不该去碰网络。
 */
export function useHeadlessBrowser(enabled = true): boolean {
  React.useEffect(() => {
    if (enabled) ensureProbe();
  }, [enabled]);
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 新建菜单用：桌面壳，或者 core 带 headless 浏览器。 */
export function useCanCreateBrowser(): boolean {
  const desktop = isDesktop();
  const remote = useHeadlessBrowser(!desktop);
  return desktop || remote;
}

/** 测试用：回到还没问过的状态。 */
export function resetBrowserAvailability(value = false): void {
  headless = value;
  probe = value ? Promise.resolve() : undefined;
  for (const listener of listeners) listener();
}
