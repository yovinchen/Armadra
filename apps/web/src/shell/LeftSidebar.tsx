/**
 * 左侧 docked 侧栏（§20 →§22 →§26）。
 *
 * 顶栏删掉之后，侧栏顶部这 44px 让位给 macOS 红绿灯：这里只留一条空占位，
 * 拖拽本身由全局的 `WindowDragLayer` 铺在窗口最上面那 44px 上统一接管
 * （折叠与展开都在，侧栏收到 0 宽也不会缺一块）。
 * 折叠按钮就贴在红绿灯右侧，**画在侧栏外面**（fixed），所以侧栏收到 0 宽之后
 * 它还在标题栏的同一个位置上——这正是 Codex 桌面版的做法。
 *
 * 折叠是把宽度收到 0（150ms 过渡）而不是卸载：里面的会话查询、树的展开状态、
 * 滚动位置都保住，展开时不用重来一遍；画布自己盯着容器尺寸重排。
 *
 * 自上而下：标题栏占位 / 工作空间名 + 搜索 + 通知 / 新建看板 / 置顶 / 项目 / 设置。
 */
import { PanelLeft, Settings } from "lucide-react";

import { useStatusCounts } from "../agent/status-store";
import { useT } from "../app/preferences-store";
import { commandKeysLabel } from "../keybindings";
import { SidebarHeader } from "../sidebar/SidebarHeader";
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

  return (
    <>
      <SidebarToggle open={open} />

      <aside
        aria-label={t("sidebar.title")}
        aria-hidden={!open}
        data-state={open ? "open" : "collapsed"}
        style={{ width: open ? "var(--sidebar-w)" : 0 }}
        className="material-sidebar h-full shrink-0 overflow-hidden border-r border-border transition-[width] duration-[var(--dur-base)] ease-out data-[state=collapsed]:border-r-0"
      >
        <div className="flex h-full w-[var(--sidebar-w)] flex-col overflow-hidden">
          <div
            aria-hidden
            data-testid="window-titlebar-inset"
            className="h-[var(--tabbar-h)] shrink-0"
          />
          <SidebarHeader />
          <WorkspaceTree />
          <Separator />
          <SidebarFooter />
        </div>
      </aside>
    </>
  );
}

/**
 * 标题栏里的折叠钮：紧贴红绿灯右侧，展开与折叠时都在同一个位置。
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
      style={{ left: trafficLightInset() + 8 }}
      className="fixed top-[9px] z-[calc(var(--z-tabbar)+1)]"
    >
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <IconButton
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
function SidebarFooter() {
  const t = useT();
  const settings = useCanvasStore((state) => state.panels.settings);
  const setPanel = useCanvasStore((state) => state.setPanel);

  return (
    <div className="shrink-0 p-2">
      <Button
        variant="ghost"
        size="sm"
        className="motion-hover h-7 w-full justify-start gap-2 px-1.5 text-[length:var(--text-body)] font-normal hover:bg-[var(--hover)]"
        onClick={() => setPanel("settings", !settings)}
      >
        <Settings className="size-4 shrink-0 opacity-70" />
        <span className="truncate">{t("cluster.settings")}</span>
      </Button>
    </div>
  );
}
