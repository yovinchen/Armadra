import { Plus, X } from "lucide-react";

import { IconButton } from "@/ui/icon-button";
import { cn } from "@/lib/cn";
import { useT } from "@/app/preferences-store";

import { MAX_TABS, tabLetter, type TabsControl } from "./webview-tabs";

/**
 * 浏览器节点的标签条。
 *
 * 一个标签就是一个 guest 元素，所以这里的每个动作都作用在渲染侧的模型上，
 * 没有会话 id、没有一次 `runtimeApi` 调用——Runtime 侧那份标签条随旧路径一
 * 起删掉了。
 *
 * 只有一个标签时不渲染：标题在节点头部，地址在地址栏，这条没有信息可给。
 */
export function WebviewTabs({ control }: { control: TabsControl }) {
  const t = useT();
  if (control.tabs.length <= 1) return null;

  return (
    <div
      className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-1 py-0.5"
      data-slot="browser-tabs"
      data-no-drag="true"
      role="tablist"
      aria-label={t("browser.tabs.label")}
    >
      {control.tabs.map((tab) => (
        <div
          key={tab.id}
          className={cn(
            "group flex h-6 min-w-0 max-w-40 shrink-0 items-center rounded-sm pr-0.5 text-[11px]",
            tab.id === control.activeId
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50",
          )}
          data-slot="browser-tab"
          data-tab-id={tab.id}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab.id === control.activeId}
            title={tab.address}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-sm pl-1.5 text-left"
            onClick={() => control.select(tab.id)}
          >
            {tab.favicon ? (
              <img
                src={tab.favicon}
                alt=""
                aria-hidden="true"
                className="size-3.5 shrink-0 rounded-[2px] object-contain"
              />
            ) : (
              <span
                aria-hidden="true"
                className="grid size-3.5 shrink-0 place-items-center rounded-[2px] bg-muted text-[8px] font-medium text-muted-foreground"
              >
                {tabLetter(tab)}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">
              {tab.title || tab.address || t("browser.tabs.untitled")}
            </span>
            {tab.loading && (
              <span
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-current opacity-60"
                data-slot="browser-tab-loading"
              />
            )}
          </button>
          <button
            type="button"
            aria-label={t("browser.tabs.close")}
            data-slot="browser-tab-close"
            className="grid size-4 shrink-0 place-items-center rounded-[2px] opacity-0 hover:bg-background/80 focus-visible:opacity-100 group-hover:opacity-100"
            onClick={() => control.close(tab.id)}
          >
            <X className="size-2.5" />
          </button>
        </div>
      ))}
      <IconButton
        label={t("browser.tabs.new")}
        disabled={control.tabs.length >= MAX_TABS}
        onClick={() => control.open(control.active.address || "about:blank")}
      >
        <Plus />
      </IconButton>
    </div>
  );
}
