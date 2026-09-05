/**
 * 左侧 docked 侧栏（§20 →§22 →§26 →§27）。
 *
 * 顶栏删掉之后，侧栏顶部这 44px 就是标题栏本身：**折叠钮、搜索、通知三个钮
 * 都住在这一行**，与 macOS 红绿灯同一条水平中线（灯心 y≈22）。左边折叠钮紧
 * 跟着红绿灯（`trafficLightInset()` 定 x），右边是搜索与通知；工作空间下拉
 * （「Armadra ⌄」）在它下面一行。
 *
 * 折叠钮**画在侧栏外面**（fixed），所以侧栏收到 0 宽之后它还在标题栏的同一
 * 个位置上——这正是 Codex 桌面版的做法。搜索与通知属于侧栏，跟着一起收。
 * 拖拽本身由全局的 `WindowDragLayer` 铺在窗口最上面那 44px 上统一接管；
 * 这一行里的按钮各自抬到 `--z-tabbar`，点击照常落在按钮上，空白处仍能拖窗。
 *
 * 折叠是把宽度收到 0（150ms 过渡）而不是卸载：里面的会话查询、树的展开状态、
 * 滚动位置都保住，展开时不用重来一遍；画布自己盯着容器尺寸重排。
 *
 * 自上而下：标题栏（折叠 / 搜索 / 通知）/ Armadra 下拉 / 新建画布 + 置顶 +
 * 项目（通知按下时这一段换成 Agent 状态面板）/ 设置。
 */
import { useCompactLayout } from "../platform/layout";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/ui/sheet";
import { useState } from "react";
import { Bell, PanelLeft, Search, Settings } from "lucide-react";

import { useStatusCounts } from "../agent/status-store";
import { useT } from "../app/preferences-store";
import { commandKeysLabel } from "../keybindings";
import { AgentStatusPanel } from "../sidebar/AgentStatusPanel";
import { SidebarHeader } from "../sidebar/SidebarHeader";
import { SidebarSearch } from "../sidebar/SidebarSearch";
import { SignalDot } from "../sidebar/SignalDot";
import { WorkspaceTree } from "../sidebar/WorkspaceTree";
import { useCanvasStore } from "../store/canvas-store";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Separator } from "@/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { noDragProps, trafficLightInset } from "./window-region";

export function LeftSidebar() {
  const t = useT();
  const open = useCanvasStore((state) => state.panels.sidebar) === "open";
  const settingsOpen = useCanvasStore((state) => state.panels.settings);
  const compact = useCompactLayout();
  // A compact sidebar is modal. Keep the desktop preference, but never create
  // a second modal over settings when resizing or opening settings by shortcut.
  const visible = open && (!compact || !settingsOpen);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const [searchOpen, setSearchOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);

  const content = (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="relative shrink-0">
        <TitlebarRow
          agentsOpen={agentsOpen}
          onSearch={() => setSearchOpen(true)}
          onToggleAgents={() => setAgentsOpen((value) => !value)}
        />
        {compact && (
          <SheetClose asChild>
            <IconButton
              size="cluster"
              label={t("sidebar.collapse")}
              className="absolute top-2 left-2"
            >
              <PanelLeft />
            </IconButton>
          </SheetClose>
        )}
      </div>
      <SidebarHeader />
      {agentsOpen ? (
        <AgentStatusPanel onClose={() => setAgentsOpen(false)} />
      ) : (
        <WorkspaceTree />
      )}
      <Separator />
      <SidebarFooter
        onNavigate={
          compact ? () => setPanel("sidebar", "collapsed") : undefined
        }
      />
    </div>
  );

  return (
    <>
      <SidebarToggle open={visible} />
      {compact ? (
        <Sheet
          open={visible}
          onOpenChange={(next) => {
            if (!useCanvasStore.getState().panels.settings)
              setPanel("sidebar", next ? "open" : "collapsed");
          }}
        >
          <SheetContent
            side="left"
            showCloseButton={false}
            aria-describedby={undefined}
            className="gap-0 bg-panel p-0 data-[side=left]:w-[min(280px,calc(100vw-48px))]"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              // Radix may run this after the closing render. Read current
              // state rather than an older closure before restoring focus.
              if (useCanvasStore.getState().panels.settings) return;
              document
                .querySelector<HTMLButtonElement>(
                  '[data-slot="sidebar-toggle"] button',
                )
                ?.focus();
            }}
          >
            <SheetTitle className="sr-only">{t("sidebar.title")}</SheetTitle>
            {content}
          </SheetContent>
        </Sheet>
      ) : (
        <aside
          aria-label={t("sidebar.title")}
          aria-hidden={!open}
          inert={!open}
          data-state={open ? "open" : "collapsed"}
          style={{ width: open ? "var(--sidebar-w)" : 0 }}
          className="material-sidebar h-full shrink-0 overflow-hidden border-r border-border transition-[width] duration-[var(--dur-base)] ease-out data-[state=collapsed]:border-r-0"
        >
          <div className="h-full w-[var(--sidebar-w)]">{content}</div>
        </aside>
      )}
      <SidebarSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}

/**
 * 标题栏那 44px：左边留给红绿灯与折叠钮（它是 fixed 的，不在这条流里），
 * 右边是搜索与通知。行本身留在正常流里，只有按钮抬到拖拽层之上，
 * 于是这一行的空白仍然能拖动窗口。
 */
function TitlebarRow({
  agentsOpen,
  onSearch,
  onToggleAgents,
}: {
  agentsOpen: boolean;
  onSearch: () => void;
  onToggleAgents: () => void;
}) {
  const t = useT();
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const counts = useStatusCounts(workspaceId);
  const hasSignal = counts.attention > 0 || counts.unread > 0;
  const tone = counts.attention > 0 ? "attention" : "unread";

  return (
    <div
      data-testid="window-titlebar-inset"
      className="flex h-[var(--tabbar-h)] shrink-0 items-center justify-end gap-0.5 px-2"
    >
      <div
        {...noDragProps()}
        className="relative z-[var(--z-tabbar)] flex items-center gap-0.5"
      >
        <IconButton
          size="cluster"
          label={t("sidebar.search")}
          onClick={onSearch}
        >
          <Search />
        </IconButton>
        <IconButton
          size="cluster"
          label={t("sidebar.notifications")}
          active={agentsOpen}
          className="relative"
          onClick={onToggleAgents}
        >
          <Bell />
          {hasSignal && (
            <SignalDot
              corner
              tone={tone}
              label={t("sidebar.hasNotifications")}
            />
          )}
        </IconButton>
      </div>
    </div>
  );
}

/**
 * 标题栏里的折叠钮：紧贴红绿灯右侧，展开与折叠时都在同一个位置。
 * 与搜索、通知统一为 28px，放在 44px 标题栏的中心线上。
 * 右上角那颗点 = 当前工作空间里有 Agent 在等你（红）或跑完没看（蓝）。
 */
function SidebarToggle({ open }: { open: boolean }) {
  const t = useT();
  const setPanel = useCanvasStore((state) => state.setPanel);
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const counts = useStatusCounts(workspaceId);
  const hasSignal = counts.attention > 0 || counts.unread > 0;
  const keys = commandKeysLabel("app.sidebar");
  const label = open ? t("sidebar.collapse") : t("sidebar.expand");

  return (
    <div
      {...noDragProps()}
      data-slot="sidebar-toggle"
      style={{ left: trafficLightInset() + 8 }}
      className="fixed top-0 z-[calc(var(--z-tabbar)+1)] flex h-[var(--tabbar-h)] items-center"
    >
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <IconButton
            size="cluster"
            label={label}
            active={open}
            className="relative"
            onClick={() => setPanel("sidebar", open ? "collapsed" : "open")}
          >
            <PanelLeft />
            {hasSignal && (
              <SignalDot
                corner
                tone={counts.attention > 0 ? "attention" : "unread"}
                label={t("sidebar.hasNotifications")}
              />
            )}
          </IconButton>
        </TooltipTrigger>
        <TooltipContent side="right">
          {keys ? `${label} ${keys}` : label}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** 底部一行：设置。Codex 那行的头像 / 语音 / 帮助我们不做。 */
function SidebarFooter({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const settings = useCanvasStore((state) => state.panels.settings);
  const setPanel = useCanvasStore((state) => state.setPanel);

  return (
    <div className="shrink-0 p-2">
      <Button
        variant="ghost"
        size="sm"
        className="motion-hover h-7 w-full justify-start gap-2 px-1.5 text-[length:var(--text-body)] font-normal hover:bg-[var(--hover)]"
        onClick={() => {
          onNavigate?.();
          setPanel("settings", !settings);
        }}
      >
        <Settings className="size-4 shrink-0 opacity-70" />
        <span className="truncate">{t("cluster.settings")}</span>
      </Button>
    </div>
  );
}
