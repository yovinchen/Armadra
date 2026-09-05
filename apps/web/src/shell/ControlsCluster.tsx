import * as React from "react";
import {
  Activity,
  FolderTree,
  GitBranch,
  Search,
  Shrink,
  SlidersHorizontal,
} from "lucide-react";
import { commandKeysLabel, type CommandId } from "../keybindings";
import { useCanvasStore } from "../store/canvas-store";
import { useT } from "../app/preferences-store";
import { CanvasPreferencesMenu } from "../canvas/CanvasPreferencesMenu";
import { cn } from "@/lib/cn";
import { DropdownMenu, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import type { ReactNode } from "react";

/**
 * 右上工具簇：首个按钮与 44px 标题栏中心线对齐。
 *
 * §24.3-2：不再是一排各自带毛玻璃的圆钮，而是**一整条** `--panel` 底、
 * 圆角 10 的条子，里面是 28×28 的 ghost 钮、间距 8。
 * 每个钮只有图标，说明走 Tooltip（§14 第 1 条，延迟 500ms）。
 *
 * §26：侧栏折叠钮搬到了标题栏红绿灯右侧（`shell/LeftSidebar`），这里没有了。
 *
 * 2026-09-05 用户反馈：最后一个钮不再是应用设置，而是**画布偏好**
 * （`canvas/CanvasPreferencesMenu`）。应用设置只剩侧栏左下角那一个入口，
 * 快捷键 ⌘, 照旧。
 */

/** 工具簇/侧栏钮共用的那条底。 */
const BAR =
  "flex flex-col gap-2 rounded-[var(--r-card)] border border-border bg-[var(--panel)]/90 p-1 shadow-[var(--shadow-pill)] backdrop-blur-[12px]";

export function ControlsCluster() {
  const t = useT();
  const [preferencesOpen, setPreferencesOpen] = React.useState(false);
  const panels = useCanvasStore((state) => state.panels);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const focusNodeId = useCanvasStore((state) => state.focusNodeId);
  const setFocusNode = useCanvasStore((state) => state.setFocusNode);

  return (
    <>
      <div
        data-slot="controls-cluster"
        className={cn(
          BAR,
          "absolute top-[3px] right-[14px] z-[var(--z-cluster)]",
        )}
      >
        <ClusterButton
          label={t("cluster.palette")}
          command="app.commandPalette"
          active={panels.palette}
          onClick={() => setPanel("palette", !panels.palette)}
        >
          <Search />
        </ClusterButton>

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
            setPanel("scm", panels.scm === "closed" ? "drawer" : "closed")
          }
        >
          <GitBranch />
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

        {focusNodeId && (
          <ClusterButton
            label={t("cluster.exitFocus")}
            command="canvas.focusMode"
            onClick={() => setFocusNode(null)}
          >
            <Shrink />
          </ClusterButton>
        )}

        <DropdownMenu open={preferencesOpen} onOpenChange={setPreferencesOpen}>
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <IconButton
                  size="cluster"
                  label={t("wb.menu")}
                  active={preferencesOpen}
                >
                  <SlidersHorizontal />
                </IconButton>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            {/* 菜单展开时不要再挂 Tooltip：它会压在第一条勾选项上。 */}
            {preferencesOpen ? null : (
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
