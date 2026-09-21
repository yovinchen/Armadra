import {
  Activity,
  FolderTree,
  GitBranch,
  GitPullRequest,
  Shrink,
  SlidersHorizontal,
} from "lucide-react";
import { commandKeysLabel, type CommandId } from "../keybindings";
import { useCanvasStore, type PanelState } from "../store/canvas-store";
import { useT } from "../app/preferences-store";
import { CanvasPreferencesMenu } from "../canvas/menus/CanvasPreferencesMenu";
import { WORK_PANEL_WIDTH, type RightPanelKey } from "../panels/WorkPanelSheet";
import { cn } from "@/lib/cn";
import { DropdownMenu, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { ClusterUsage } from "./ClusterUsage";
import { noDragProps } from "./window-region";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { useMenuTooltip } from "./menu-tooltip";
import type { ReactNode } from "react";

/**
 * 右上工具簇：离上边与右边各 14px，与右下缩略图、底部 Dock 同一套边距
 * （2026-09-14 反馈；此前是贴着标题栏中心线的 3px）。
 *
 * §24.3-2：不再是一排各自带毛玻璃的圆钮，而是**一整条** `--panel` 底、
 * 圆角 10 的条子，里面是 28×28 的 ghost 钮、间距 8。
 * 每个钮只有图标，说明走 Tooltip（§14 第 1 条，延迟 500ms）。
 *
 * §26：侧栏折叠钮搬到了标题栏红绿灯右侧（`shell/LeftSidebar`），这里没有了。
 *
 * 2026-09-05 用户反馈：最后一个钮不再是应用设置，而是**画布偏好**
 * （`canvas/menus/CanvasPreferencesMenu`）。应用设置只剩侧栏左下角那一个入口，
 * 快捷键 ⌘, 照旧。
 *
 * 2026-09-15 用户反馈：命令面板的「搜索」钮去掉——它只是打开面板，快捷键
 * （`app.commandPalette`）与侧栏顶部的入口都还在。
 */

/** 工具簇/侧栏钮共用的那条底。 */
const BAR =
  "flex flex-col gap-2 rounded-[var(--r-card)] border border-border bg-[var(--panel)]/90 p-1 shadow-[var(--shadow-pill)] backdrop-blur-[12px]";

/**
 * 开着的那块右侧工作面板（`panels/WorkPanelSheet`）。抽屉是窗口级的固定层，
 * 正好盖在这条工具簇上；不让开的话开着抽屉时这几个按钮一个都按不到——
 * 用户点「资源管理器」以为没反应，其实点在抽屉上。
 */
function openWorkPanel(panels: PanelState): RightPanelKey | null {
  for (const key of Object.keys(WORK_PANEL_WIDTH) as RightPanelKey[]) {
    if (panels[key] === "drawer") return key;
  }
  return null;
}

export function ControlsCluster() {
  const t = useT();
  const preferences = useMenuTooltip();
  const panels = useCanvasStore((state) => state.panels);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const focusNodeId = useCanvasStore((state) => state.focusNodeId);
  const setFocusNode = useCanvasStore((state) => state.setFocusNode);
  const drawer = openWorkPanel(panels);

  return (
    <>
      <div
        data-slot="controls-cluster"
        // 簇的第一格落在窗口顶部 44px 的拖拽带里；不写回 no-drag，那一格按下去
        // 是拖窗口。
        {...noDragProps()}
        style={{
          right: drawer
            ? `calc(14px + min(100vw, ${WORK_PANEL_WIDTH[drawer]}))`
            : undefined,
        }}
        className={cn(
          BAR,
          "absolute top-[14px] right-[14px] z-[var(--z-cluster)]",
          "transition-[right] duration-150 ease-out motion-reduce:transition-none",
        )}
      >
        <ClusterButton
          label={t("cluster.explorer")}
          command="app.explorer"
          active={panels.explorer !== "closed"}
          onClick={() =>
            setPanel(
              "explorer",
              panels.explorer === "closed" ? "drawer" : "closed",
            )
          }
        >
          <FolderTree />
        </ClusterButton>

        <ClusterButton
          label={t("cluster.scm")}
          command="app.sourceControl"
          active={panels.scm !== "closed"}
          onClick={() =>
            // 底部停靠：Git 工具窗口的三栏要的是宽度（Git 工具窗口设计 §2.1）。
            setPanel("scm", panels.scm === "closed" ? "bottom" : "closed")
          }
        >
          <GitBranch />
        </ClusterButton>

        <ClusterButton
          label={t("cluster.github")}
          command="app.github"
          active={panels.github !== "closed"}
          onClick={() =>
            setPanel("github", panels.github === "closed" ? "drawer" : "closed")
          }
        >
          <GitPullRequest />
        </ClusterButton>

        <ClusterButton
          label={t("cluster.resources")}
          command="app.resources"
          active={panels.resources !== "closed"}
          onClick={() =>
            setPanel(
              "resources",
              panels.resources === "closed" ? "drawer" : "closed",
            )
          }
        >
          <Activity />
        </ClusterButton>

        <ClusterUsage />

        {focusNodeId && (
          <ClusterButton
            label={t("cluster.exitFocus")}
            command="canvas.focusMode"
            onClick={() => setFocusNode(null)}
          >
            <Shrink />
          </ClusterButton>
        )}

        <DropdownMenu {...preferences.menuProps}>
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild {...preferences.tooltipTriggerProps}>
              <DropdownMenuTrigger asChild>
                <IconButton
                  size="cluster"
                  label={t("wb.menu")}
                  active={preferences.menuOpen}
                >
                  <SlidersHorizontal />
                </IconButton>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            {/* 菜单展开时不要再挂 Tooltip：它会压在第一条勾选项上。
                菜单**关掉**之后也不该弹回来，那一下由 `useMenuTooltip` 拦。 */}
            {preferences.menuOpen ? null : (
              <TooltipContent side="left">{t("wb.menu")}</TooltipContent>
            )}
          </Tooltip>
          <CanvasPreferencesMenu />
        </DropdownMenu>
      </div>
    </>
  );
}

function ClusterButton({
  label,
  command,
  active,
  onClick,
  children,
}: {
  label: string;
  command: CommandId;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const keys = commandKeysLabel(command);
  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <IconButton
          size="cluster"
          label={label}
          active={active}
          onClick={onClick}
        >
          {children}
        </IconButton>
      </TooltipTrigger>
      <TooltipContent side="left">
        {keys ? `${label} ${keys}` : label}
      </TooltipContent>
    </Tooltip>
  );
}
