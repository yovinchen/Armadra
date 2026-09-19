import { Plus, X } from "lucide-react";

import { IconButton } from "@/ui/icon-button";
import { cn } from "@/lib/cn";
import { useT } from "@/app/preferences-store";

import { tabLetter } from "./TabStrip";
import { MAX_TABS, type TabsControl } from "./webview-tabs";

/**
 * Electron 分支的标签条。
 *
 * 和 `TabStrip.tsx` 长得一样是有意的——对人来说这是同一条控件，只是底下换了
 * 引擎。不复用那一个是因为它的每一个动作都是一次 `runtimeApi` 调用，而这条
 * 路上根本没有会话 id；把两种数据源塞进同一个组件只会让两边都变难读。
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
                {tabLetter({ title: tab.title, url: tab.address })}
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
