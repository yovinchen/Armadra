import * as React from "react";
import { readStored, writeStored } from "@/app/preferences/storage";

/**
 * 浏览器节点的项目内历史（editor-browser-design §5「项目范围历史」）。
 *
 * 按工作空间分开：同一个项目的几个浏览器节点共用一份，换个项目就是另一份
 * ——和它们共用的 partition（登录状态）是同一个边界。存在本地偏好里而不是
 * 节点数据：节点删了、再建一个，项目里去过哪些页面仍然有用；而写进画布文档
 * 会让每一次导航都变成一次画布保存。
 *
 * 只记 http(s) 地址，去重后最近的在前，上限 {@link HISTORY_LIMIT} 条。
 */

export const HISTORY_LIMIT = 50;
const PREFIX = "armadra.browser.history.";

const listeners = new Set<() => void>();
const cache = new Map<string, readonly string[]>();

function key(workspaceId: string): string {
  return `${PREFIX}${workspaceId}`;
}

export function browserHistory(workspaceId: string): readonly string[] {
  const cached = cache.get(workspaceId);
  if (cached) return cached;
  let entries: string[] = [];
  try {
    const parsed: unknown = JSON.parse(readStored(key(workspaceId)) ?? "[]");
    if (Array.isArray(parsed)) {
      entries = parsed
        .filter((item): item is string => typeof item === "string")
        .slice(0, HISTORY_LIMIT);
    }
  } catch {
    // 坏数据当作没有历史。
  }
  cache.set(workspaceId, entries);
  return entries;
}

function write(workspaceId: string, entries: readonly string[]): void {
  cache.set(workspaceId, entries);
  writeStored(key(workspaceId), JSON.stringify(entries));
  for (const listener of listeners) listener();
}

export function recordBrowserHistory(workspaceId: string, url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const current = browserHistory(workspaceId);
  if (current[0] === url) return;
  write(
    workspaceId,
    [url, ...current.filter((entry) => entry !== url)].slice(0, HISTORY_LIMIT),
  );
}

export function clearBrowserHistory(workspaceId: string): void {
  write(workspaceId, []);
}

/** 「清理浏览数据」连同所有工作空间的历史一起清：去过哪些页面也是浏览数据。 */
export function clearAllBrowserHistory(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const name = localStorage.key(index);
      if (name?.startsWith(PREFIX)) keys.push(name);
    }
    for (const name of keys) localStorage.removeItem(name);
  } catch {
    // 存储不可用时本来也没有历史落过盘。
  }
  cache.clear();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const EMPTY: readonly string[] = [];

export function useBrowserHistory(
  workspaceId: string | undefined,
): readonly string[] {
  const read = React.useCallback(
    () => (workspaceId ? browserHistory(workspaceId) : EMPTY),
    [workspaceId],
  );
  return React.useSyncExternalStore(subscribe, read, read);
}

/** 测试用：丢掉内存里的缓存，下次从存储重读。 */
export function resetBrowserHistoryCache(): void {
  cache.clear();
}
