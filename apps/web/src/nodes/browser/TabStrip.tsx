import * as React from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import type { BrowserTab, BrowserTabList } from "@armadra/shared";

import { IconButton } from "@/ui/icon-button";
import { cn } from "@/lib/cn";
import { runtimeApi } from "@/api/client";
import { onWorkspaceEvent } from "@/api/events";
import { useT } from "@/app/preferences-store";

/**
 * 一个会话的标签条（设计 §2.2 / §2.8）。
 *
 * 标签是会话内的东西：一个进程、一个 profile、若干个 CDP target。页面自己
 * `window.open` 出来的也落在这里，所以这条不是装饰——没有它，一次弹窗之后
 * 人看不出自己在哪一页上，也回不到原来那一页。
 */
export function useTabs(
  workspaceId: string | undefined,
  sessionId: string | null,
): BrowserTabList | null {
  const [tabs, setTabs] = React.useState<BrowserTabList | null>(null);

  React.useEffect(() => {
    if (!workspaceId || !sessionId) {
      setTabs(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    // 先取一次再听推送：节点是后挂上来的，会话可能已经开了三个标签，只听
    // 事件的话在下一次变化之前条上什么都没有。
    void runtimeApi
      .browserTabs(workspaceId, sessionId, controller.signal)
      .then((list) => {
        if (!cancelled) setTabs(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [workspaceId, sessionId]);

  React.useEffect(
    () =>
      onWorkspaceEvent("browser.tabs", (event) => {
        if (event.sessionId === sessionId) setTabs(event.tabs);
      }),
    [sessionId],
  );

  return tabs;
}

/** 没有图标时的替身：站点首字母，而不是一个到处都一样的通用图标。 */
export function tabLetter(tab: Pick<BrowserTab, "title" | "url">): string {
  try {
    const host = new URL(tab.url).hostname.replace(/^www\./, "");
    if (host) return host[0]!.toUpperCase();
  } catch {
    /* 还没导航完的标签没有可解析的地址，用标题顶上。 */
  }
  const source = (tab.title || tab.url).trim();
  return (source[0] ?? "·").toUpperCase();
}

function TabIcon({ tab }: { tab: BrowserTab }) {
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => setBroken(false), [tab.favicon]);
  if (tab.favicon && !broken) {
    return (
      <img
        src={tab.favicon}
        alt=""
        aria-hidden="true"
        className="size-3.5 shrink-0 rounded-[2px] object-contain"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="grid size-3.5 shrink-0 place-items-center rounded-[2px] bg-muted text-[8px] font-medium text-muted-foreground"
    >
      {tabLetter(tab)}
    </span>
  );
}

export function TabStrip({
  workspaceId,
  sessionId,
  tabs,
  newTabUrl,
}: {
  workspaceId: string | undefined;
  sessionId: string | null;
  tabs: BrowserTabList | null;
  /** 「新建」开在哪：节点当前的地址，没有就开一张空白页。 */
  newTabUrl: string;
}) {
  const t = useT();
  const [busy, setBusy] = React.useState(false);

  if (!tabs || !workspaceId || !sessionId) return null;
  // 只有一个标签时这条没有信息可给：标题在节点头部，地址在地址栏。
  if (tabs.tabs.length <= 1) return null;

  const act = (work: Promise<unknown>) => {
    setBusy(true);
    void work
      .catch((cause: unknown) => {
        // 最后一个标签是 409 `LAST_TAB`，Runtime 的话已经说清了为什么关不
        // 掉——结束会话是另一条路，不在这条上。
        toast.error(
          cause instanceof Error ? cause.message : t("browser.tabs.failed"),
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-1 py-0.5"
      data-slot="browser-tabs"
      data-no-drag="true"
      role="tablist"
      aria-label={t("browser.tabs.label")}
    >
      {tabs.tabs.map((tab) => (
        <div
          key={tab.tabId}
          className={cn(
            "group flex h-6 min-w-0 max-w-40 shrink-0 items-center rounded-sm pr-0.5 text-[11px]",
            tab.active
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50",
          )}
          data-slot="browser-tab"
          data-tab-id={tab.tabId}
        >
          {/*
            关闭是它自己的按钮，所以标签本身也是一个按钮而不是一个包着按钮
            的按钮——后者是无效 HTML，键盘走到里面就没法出来了。
          */}
          <button
            type="button"
            role="tab"
            aria-selected={tab.active}
            disabled={busy}
            title={tab.url}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-sm pl-1.5 text-left"
            onClick={() => {
              if (tab.active) return;
              act(
                runtimeApi.browserActivateTab(
                  workspaceId,
                  sessionId,
                  tab.tabId,
                ),
              );
            }}
          >
            <TabIcon tab={tab} />
            <span className="min-w-0 flex-1 truncate">
              {tab.title || tab.url || t("browser.tabs.untitled")}
            </span>
            {/*
              加载中和待答复的对话框是两件不同的事，所以是两个不同的记号：
              前者会自己结束，后者要人答复，在它之前这个标签上的输入一律被
              拒（§2.4）。
            */}
            {tab.pendingDialog ? (
              <span
                className="size-1.5 shrink-0 rounded-full bg-[var(--status-attention)]"
                data-slot="browser-tab-dialog"
                title={tab.pendingDialog.message}
              />
            ) : tab.loading ? (
              <span
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-current opacity-60"
                data-slot="browser-tab-loading"
              />
            ) : null}
          </button>
          <button
            type="button"
            aria-label={t("browser.tabs.close")}
            data-slot="browser-tab-close"
            disabled={busy}
            className="grid size-4 shrink-0 place-items-center rounded-[2px] opacity-0 hover:bg-background/80 focus-visible:opacity-100 group-hover:opacity-100"
            onClick={() =>
              act(runtimeApi.browserCloseTab(workspaceId, sessionId, tab.tabId))
            }
          >
            <X className="size-2.5" />
          </button>
        </div>
      ))}
      <IconButton
        label={t("browser.tabs.new")}
        disabled={busy || tabs.tabs.length >= tabs.limit}
        onClick={() =>
          act(
            runtimeApi.browserOpenTab(
              workspaceId,
              sessionId,
              newTabUrl || "about:blank",
            ),
          )
        }
      >
        <Plus />
      </IconButton>
    </div>
  );
}
