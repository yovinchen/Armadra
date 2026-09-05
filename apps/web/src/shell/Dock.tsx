import { useValue, type Editor } from "tldraw";
import { Gauge, LayoutGrid, Plus, Redo2, Undo2 } from "lucide-react";
import { AddMenuContent } from "../canvas/menus/AddMenuContent";
import { visiblePageBounds } from "../canvas/tidy-editor";
import { DockTools } from "./DockTools";
import {
  getEditor,
  screenToPage,
  useEditorHandle,
} from "../canvas/editor-context";
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

const ZOOM_DURATION = 120;
const FIT_DURATION = 160;

/**
 * 缩放到某一档，锚点是视口中心。
 *
 * tldraw 只有 `zoomIn` / `zoomOut`（沿 `zoomSteps` 走一格）和 `resetZoom`，
 * 没有「缩放到任意倍率」，所以这里照抄 `Editor.zoomIn` 的相机换算：
 * 屏幕点 `p` 下的页面坐标在缩放前后不变 ⇒ `c' = c + p/z' - p/z`。
 */
function zoomToLevel(editor: Editor, zoom: number): void {
  const point = editor.getViewportScreenCenter();
  const { x, y, z } = editor.getCamera();
  editor.setCamera(
    {
      x: x + point.x / zoom - point.x / z,
      y: y + point.y / zoom - point.y / z,
      z: zoom,
    },
    { animation: { duration: ZOOM_DURATION } },
  );
}

/** 适应视图，只缩小不放大（§20：最多到 100%）。 */
function zoomToFit(editor: Editor): void {
  const bounds = visiblePageBounds(editor);
  if (!bounds) return;
  editor.zoomToBounds(
    { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height },
    {
      targetZoom: 1,
      animation: { duration: FIT_DURATION },
    },
  );
}

/** 当前缩放百分比；画布没挂载时是 100%。 */
function useZoomLevel(editor: Editor | null): number {
  return useValue("canvas zoom", () => editor?.getZoomLevel() ?? 1, [editor]);
}

/**
 * 底部 Dock（§3.1）：`+` / 撤销 / 重做 / 保存点 / 缩放。
 * 保存状态只用一个点表示，不写文字（§14 第 4 条）。
 */
export function Dock() {
  const t = useT();
  const editor = useEditorHandle();
  const zoom = useZoomLevel(editor);
  const workspace = useCanvasStore((state) => state.workspace);
  const addNode = useCanvasStore((state) => state.addNode);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const agents = useEnabledAgents();
  const usagePanel = useCanvasStore((state) => state.panels.usage);
  const setPanel = useCanvasStore((state) => state.setPanel);

  if (!workspace) return null;

  const center = () => {
    const { innerWidth, innerHeight } = window;
    return screenToPage({ x: innerWidth / 2, y: innerHeight / 2 });
  };

  return (
    <div
      data-slot="dock"
      className="canvas-dock z-[var(--z-dock)] flex h-[var(--dock-h)] items-center gap-1 rounded-[var(--r-panel)] border border-border bg-[var(--panel)]/90 px-1.5 shadow-[var(--shadow-pill)] backdrop-blur-[12px]"
    >
      <DropdownMenu>
        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <IconButton size="dock" label={t("dock.add")}>
                <Plus />
              </IconButton>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("dock.add")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="center"
          side="top"
          className="z-[var(--z-menu)]"
        >
          <AddMenuContent
            kind="dropdown"
            ctx={{ addNode, position: center(), workspace, agents }}
          />
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

      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <IconButton
            size="dock"
            label={t("usage.dashboard.open")}
            active={usagePanel !== "closed"}
            onClick={() =>
              setPanel("usage", usagePanel === "closed" ? "drawer" : "closed")
            }
          >
            <Gauge />
          </IconButton>
        </TooltipTrigger>
        <TooltipContent>{t("usage.dashboard.open")}</TooltipContent>
      </Tooltip>

      {/* 白板工具组（§5）；画布没挂载时整组连同分隔线一起不渲染。 */}
      <DockTools />

      <Separator orientation="vertical" className="mx-1 h-5" />

      <SaveDot />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            size="dock"
            label={t("dock.zoom")}
            className="w-[52px] text-[length:var(--text-caption)] font-medium tabular-nums"
          >
            {Math.round(zoom * 100)}%
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="center"
          side="top"
          className="z-[var(--z-menu)]"
        >
          {ZOOM_STEPS.map((step) => (
            <DropdownMenuItem
              key={step}
              data-checked={Math.abs(zoom - step) < 0.005 ? "true" : undefined}
              onSelect={() => {
                const target = getEditor();
                if (target) zoomToLevel(target, step);
              }}
            >
              {Math.round(step * 100)}%
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              const target = getEditor();
              if (target) zoomToFit(target);
            }}
          >
            {t("dock.zoomFit")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** 保存状态：一个 10px 的点，说明只在 Tooltip 里。 */
function SaveDot() {
  const t = useT();
  const saveState = useCanvasStore((state) => state.saveState);
  const label = t(`dock.save.${saveState}`);
  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <span
          data-slot="save-dot"
          data-state={saveState}
          role="status"
          aria-label={label}
          className={cn(
            "mx-1 size-2 shrink-0 rounded-full",
            saveState === "error" && "bg-danger",
            saveState === "saving" && "anim-dot-pulse bg-warn",
            saveState === "dirty" && "bg-warn",
            (saveState === "saved" || saveState === "idle") && "bg-success/70",
          )}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
