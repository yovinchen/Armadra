import { useViewport } from "@xyflow/react";
import { LayoutGrid, Lock, LockOpen, Plus, Redo2, Undo2 } from "lucide-react";
import {
  ADD_MENU_CONTENT_CLASS,
  AddMenuContent,
} from "../canvas/menus/AddMenuContent";
import { DockTools } from "./DockTools";
import { setCanvasLocked, useCanvasLocked } from "../canvas/canvas-lock";
import { DockUsage } from "./DockUsage";
import { useMenuTooltip } from "./menu-tooltip";
import { currentViewportCenter } from "../canvas/placement";
import { fitView, zoomToLevel } from "../canvas/flow/use-flow-viewport";
import { canEditCanvas, useCanvasOwnership } from "../canvas-ownership";
import { useCanUndo, useCanRedo, useCanvasStore } from "../store/canvas-store";
import { useEnabledAgents } from "../app/use-agents";
import { useT } from "../app/preferences-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { runCanvasCommand } from "@/canvas/commands";
import { Separator } from "@/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/cn";

/** 缩放预设（§20）：50 / 100 / 150 + 适应。以视口中心为锚点。 */
const ZOOM_STEPS = [0.5, 1, 1.5] as const;

/**
 * 底部 Dock（§3.1）：`+` / 撤销 / 重做 / 整理 / 工具 / 保存点 / 缩放 / 用量。
 * 保存状态只用一个点表示，不写文字（§14 第 4 条）。
 *
 * 用量在最右端（F9）：它以前是右下角一个独立浮层，用户要求并进 Dock。
 * 锁定视图在最左端（2026-09-14 反馈）：它以前是左下角一个独立的浮钮，
 * 用户要求并进 Dock，Dock 本身居中。
 */
export function Dock() {
  const t = useT();
  const locked = useCanvasLocked();
  // `useViewport` 要在 `<ReactFlowProvider>` 之下：Dock 挂在 `App` 里，
  // provider 包着整棵树（§2.9），所以这里读得到。
  const { zoom } = useViewport();
  const workspace = useCanvasStore((state) => state.workspace);
  const addNode = useCanvasStore((state) => state.addNode);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const agents = useEnabledAgents();
  const addMenu = useMenuTooltip();
  const zoomMenu = useMenuTooltip();

  if (!workspace) return null;

  return (
    // 外层是一条贯穿画布底部的网格行（`styles/canvas.css`）：中间那格装
    // Dock，两侧留白相等时 Dock 就在画布正中；右侧留白有下限（缩略图的
    // 宽度加边距），画布不够宽时 Dock 向左让，缩略图永远留在右下角。
    <div className="canvas-dock-row">
      <div
        data-slot="dock"
        className="canvas-dock z-[var(--z-dock)] flex h-[var(--dock-h)] items-center gap-1 rounded-[var(--r-panel)] border border-border bg-[var(--panel)]/90 px-1.5 shadow-[var(--shadow-pill)] backdrop-blur-[12px]"
      >
        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <IconButton
              size="dock"
              data-slot="canvas-lock"
              label={locked ? t("canvas.unlock") : t("canvas.lock")}
              aria-pressed={locked}
              active={locked}
              onClick={() => setCanvasLocked(!locked)}
            >
              {locked ? <Lock /> : <LockOpen />}
            </IconButton>
          </TooltipTrigger>
          <TooltipContent>
            {locked ? t("canvas.unlock") : t("canvas.lock")}
          </TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <DropdownMenu {...addMenu.menuProps}>
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild {...addMenu.tooltipTriggerProps}>
              <DropdownMenuTrigger asChild>
                <IconButton
                  size="dock"
                  label={t("dock.add")}
                  active={addMenu.menuOpen}
                >
                  <Plus />
                </IconButton>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            {/* 菜单展开时不再挂提示：它会压在第一条菜单项上。 */}
            {addMenu.menuOpen ? null : (
              <TooltipContent>{t("dock.add")}</TooltipContent>
            )}
          </Tooltip>
          <DropdownMenuContent
            align="center"
            side="top"
            className={cn("z-[var(--z-menu)]", ADD_MENU_CONTENT_CLASS)}
          >
            {/* 落点在**展开这一刻**算：菜单开着时相机还能动。 */}
            {addMenu.menuOpen && (
              <AddMenuContent
                kind="dropdown"
                ctx={{
                  addNode,
                  position: currentViewportCenter(),
                  workspace,
                  agents,
                }}
              />
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <IconButton
              size="dock"
              label={t("dock.undo")}
              disabled={!canUndo}
              onClick={() => undo()}
            >
              <Undo2 />
            </IconButton>
          </TooltipTrigger>
          <TooltipContent>{t("dock.undo")}</TooltipContent>
        </Tooltip>

        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <IconButton
              size="dock"
              label={t("dock.redo")}
              disabled={!canRedo}
              onClick={() => redo()}
            >
              <Redo2 />
            </IconButton>
          </TooltipTrigger>
          <TooltipContent>{t("dock.redo")}</TooltipContent>
        </Tooltip>

        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <IconButton
              size="dock"
              label={t("dock.tidy")}
              onClick={() => runCanvasCommand("canvas.tidy")}
            >
              <LayoutGrid />
            </IconButton>
          </TooltipTrigger>
          <TooltipContent>{t("dock.tidy")}</TooltipContent>
        </Tooltip>

        {/* 白板工具组（§5）；画布没挂载时整组连同分隔线一起不渲染。 */}
        <DockTools />

        <Separator orientation="vertical" className="mx-1 h-5" />

        <SaveDot />

        <DropdownMenu {...zoomMenu.menuProps}>
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild {...zoomMenu.tooltipTriggerProps}>
              <DropdownMenuTrigger asChild>
                <IconButton
                  size="dock"
                  label={t("dock.zoom")}
                  active={zoomMenu.menuOpen}
                  className="w-[52px] text-[length:var(--text-caption)] font-medium tabular-nums"
                >
                  {Math.round(zoom * 100)}%
                </IconButton>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            {zoomMenu.menuOpen ? null : (
              <TooltipContent>{t("dock.zoom")}</TooltipContent>
            )}
          </Tooltip>
          <DropdownMenuContent
            align="center"
            side="top"
            className="z-[var(--z-menu)] w-auto min-w-32"
          >
            {ZOOM_STEPS.map((step) => (
              <DropdownMenuItem
                key={step}
                data-checked={
                  Math.abs(zoom - step) < 0.005 ? "true" : undefined
                }
                onSelect={() => zoomToLevel(step)}
              >
                {Math.round(step * 100)}%
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={fitView}>
              {t("dock.zoomFit")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DockUsage />
      </div>
    </div>
  );
}

/** 保存状态：一个 10px 的点，说明只在 Tooltip 里。 */
function SaveDot() {
  const t = useT();
  const saveState = useCanvasStore((state) => state.saveState);
  const ownership = useCanvasOwnership((state) => state.status);
  /**
   * 归属没落定时这盏灯是「只读」，不是「已保存」（H01 §4）。
   * 维护窗口里画布确实写不进去，把它显示成绿色等于报了个假平安。
   */
  const writable = canEditCanvas(ownership);
  const state = writable ? saveState : "readonly";
  const label = writable
    ? t(`dock.save.${saveState}`)
    : t("ownership.save.readonly");
  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <span
          data-slot="save-dot"
          data-state={state}
          role="status"
          aria-label={label}
          className={cn(
            "mx-1 size-2 shrink-0 rounded-full",
            !writable && "bg-muted-foreground/60",
            writable && saveState === "error" && "bg-danger",
            writable && saveState === "saving" && "anim-dot-pulse bg-warn",
            writable && saveState === "dirty" && "bg-warn",
            writable &&
              (saveState === "saved" || saveState === "idle") &&
              "bg-success/70",
          )}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
