import * as React from "react";

/**
 * Electron 分支的标签模型（W3.1）。
 *
 * screencast 那条路上标签是 Runtime 的东西（一个进程、若干个 CDP target，
 * `TabStrip.tsx` + `browser.tabs` 事件）。`<webview>` 上没有那个进程，一个标
 * 签就是一个 guest 元素，所以模型只能住在渲染侧——**这不是重复实现**，两条
 * 路的标签根本不是同一种东西。
 *
 * 上限沿用 Runtime 的 `MAX_TABS`（`apps/runtime/src/browser/model.rs:136`）：
 * 两条路给人的感觉应当一样，而 16 个 guest 已经是十几个渲染进程。
 */
export const MAX_TABS = 16;

export interface WebviewTab {
  /** 稳定 key。**绝不复用**：key 变了 React 会重建元素，guest 跟着死。 */
  readonly id: string;
  /** 挂给 `<webview src>` 的值。只在显式导航时变，`did-navigate` 不改它。 */
  src: string;
  /** 地址栏显示的值，跟着 `did-navigate` 走。 */
  address: string;
  title: string;
  favicon: string;
  loading: boolean;
  audible: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

let counter = 0;
function nextTabId(): string {
  counter += 1;
  return `wv-${counter}`;
}

export function newTab(url: string): WebviewTab {
  return {
    id: nextTabId(),
    src: url,
    address: url,
    title: "",
    favicon: "",
    loading: Boolean(url),
    audible: false,
    canGoBack: false,
    canGoForward: false,
  };
}

export interface TabsControl {
  tabs: WebviewTab[];
  activeId: string;
  active: WebviewTab;
  select(id: string): void;
  open(url: string): void;
  close(id: string): void;
  patch(id: string, change: Partial<Omit<WebviewTab, "id">>): void;
}

/**
 * 标签集合。`initialUrl` 只在第一次挂载时读——之后 URL 的真相在标签里。
 *
 * 关掉最后一个标签是**无操作**：那一条在 Runtime 侧是 409 `LAST_TAB`，这里同
 * 样不给，理由一样——关掉节点是另一条路（头部的 ×），不在这条上。
 */
export function useWebviewTabs(initialUrl: string): TabsControl {
  const [tabs, setTabs] = React.useState<WebviewTab[]>(() => [
    newTab(initialUrl),
  ]);
  const [activeId, setActiveId] = React.useState(() => tabs[0]!.id);

  const open = React.useCallback((url: string) => {
    setTabs((current) => {
      if (current.length >= MAX_TABS) return current;
      const tab = newTab(url);
      setActiveId(tab.id);
      return [...current, tab];
    });
  }, []);

  const close = React.useCallback((id: string) => {
    setTabs((current) => {
      if (current.length <= 1) return current;
      const index = current.findIndex((tab) => tab.id === id);
      if (index < 0) return current;
      const next = current.filter((tab) => tab.id !== id);
      setActiveId((active) =>
        active === id ? next[Math.min(index, next.length - 1)]!.id : active,
      );
      return next;
    });
  }, []);

  const patch = React.useCallback(
    (id: string, change: Partial<Omit<WebviewTab, "id">>) => {
      setTabs((current) => {
        const index = current.findIndex((tab) => tab.id === id);
        if (index < 0) return current;
        const merged = { ...current[index]!, ...change };
        // 逐字段比一次：guest 的 `did-stop-loading` 在一个稳定页面上也会连着
        // 报几次同样的值，每次都换一个新数组等于每次都重渲整条标签栏。
        let changed = false;
        for (const key of Object.keys(change) as (keyof WebviewTab)[]) {
          if (merged[key] !== current[index]![key]) changed = true;
        }
        if (!changed) return current;
        const next = [...current];
        next[index] = merged;
        return next;
      });
    },
    [],
  );

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]!;

  return {
    tabs,
    activeId: active.id,
    active,
    select: setActiveId,
    open,
    close,
    patch,
  };
}

/** 没有图标时的替身：站点首字母，而不是一个到处都一样的通用图标。 */
export function tabLetter(tab: Pick<WebviewTab, "title" | "address">): string {
  try {
    const host = new URL(tab.address).hostname.replace(/^www\./, "");
    if (host) return host[0]!.toUpperCase();
  } catch {
    /* 还没导航完的标签没有可解析的地址，用标题顶上。 */
  }
  const source = (tab.title || tab.address).trim();
  return (source[0] ?? "·").toUpperCase();
}
