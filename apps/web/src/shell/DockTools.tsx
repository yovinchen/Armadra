import * as React from "react";
import { Shapes } from "lucide-react";
import { useValue } from "tldraw";
import { GeoShapeGeoStyle } from "@tldraw/tlschema";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { IconButton } from "@/ui/icon-button";
import { Separator } from "@/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { useT } from "@/app/preferences-store";
import { useCanvasLocked } from "@/canvas/canvas-lock";
import { runCanvasCommand } from "@/canvas/commands";
import { getEditor, useEditorHandle } from "@/canvas/editor-context";
import {
  CANVAS_TOOLS,
  GEO_OPTIONS,
  IMAGE_TOOL,
  geoIcon,
  isToolDisabledWhenLocked,
  type CanvasToolSpec,
} from "@/canvas/tools";
import { commandKeysLabel, type CommandId } from "@/keybindings";

/**
 * Dock 的白板工具组（tldraw 计划 §5）。
 *
 * 高亮跟着 `editor.getCurrentToolId()` 走，点击只发画布命令——真正的
 * `editor.setCurrentTool` 在 `TldrawWorkspace` 里注册，所以快捷键、命令
 * 面板、这一排按钮走的是同一条路径。
 *
 * 画布没挂载（启动页）时整组不渲染：没有 editor 就没有工具可切。
 */
export function DockTools() {
  const t = useT();
  const editor = useEditorHandle();
  const locked = useCanvasLocked();
  const currentTool = useValue(
    "canvas tool",
    () => editor?.getCurrentToolId() ?? "select",
    [editor],
  );

  if (!editor) return null;

  const buttons = (
    <>
      {CANVAS_TOOLS.map((tool) =>
        tool.id === "geo" ? (
          <GeoToolButton
            key={tool.id}
            tool={tool}
            active={currentTool === "geo"}
            disabled={locked}
          />
        ) : (
          <ToolButton
            key={tool.id}
            tool={tool}
            active={currentTool === tool.id}
            disabled={locked && isToolDisabledWhenLocked(tool.id)}
          />
        ),
      )}
      <ImageToolButton disabled={locked} />
    </>
  );

  return (
    <>
      <Separator orientation="vertical" className="mx-1 h-5" />
      <div className="dock-tools-expanded items-center gap-1">{buttons}</div>
      <div className="dock-tools-compact">
        <Popover>
          <PopoverTrigger asChild>
            <IconButton size="dock" label={t("dock.tools")}>
              <Shapes />
            </IconButton>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="center"
            className="z-[var(--z-menu)] grid w-auto min-w-0 grid-cols-5 gap-1 p-2"
            aria-label={t("dock.tools")}
          >
            {buttons}
          </PopoverContent>
        </Popover>
      </div>
    </>
  );
}

/** 工具按钮上的 Tooltip：名字 + 当前键位（键位从命令表读，不写死）。 */
function toolTooltip(
  labelKey: string,
  command: string,
  t: ReturnType<typeof useT>,
): string {
  const keys = commandKeysLabel(command as CommandId);
  const label = t(labelKey);
  return keys ? `${label} · ${keys}` : label;
}

interface ToolButtonProps {
  tool: CanvasToolSpec;
  active: boolean;
  disabled: boolean;
}

function ToolButton({ tool, active, disabled }: ToolButtonProps) {
  const t = useT();
  const Icon = tool.icon;
  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <IconButton
          size="dock"
          label={t(tool.labelKey)}
          active={active}
          disabled={disabled}
          onClick={() => runCanvasCommand(tool.command)}
        >
          <Icon />
        </IconButton>
      </TooltipTrigger>
      <TooltipContent>
        {toolTooltip(tool.labelKey, tool.command, t)}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 形状按钮：点开就切到形状工具，菜单里挑的是 tldraw 的 `geo` 样式，
 * 所以按钮图标、样式面板里的形状选择器、下一个画出来的 shape 永远一致。
 */
function GeoToolButton({ tool, active, disabled }: ToolButtonProps) {
  const t = useT();
  const editor = useEditorHandle();
  const geo = useValue(
    "canvas geo",
    () => editor?.getStyleForNextShape(GeoShapeGeoStyle) ?? "rectangle",
    [editor],
  );
  const Icon = geoIcon(geo);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) runCanvasCommand(tool.command);
      }}
    >
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <IconButton
              size="dock"
              label={t(tool.labelKey)}
              active={active}
              disabled={disabled}
            >
              <Icon />
            </IconButton>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {toolTooltip(tool.labelKey, tool.command, t)}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="center"
        side="top"
        className="z-[var(--z-menu)]"
      >
        {GEO_OPTIONS.map((option) => {
          const OptionIcon = option.icon;
          return (
            <DropdownMenuItem
              key={option.geo}
              data-checked={geo === option.geo ? "true" : undefined}
              onSelect={() => {
                const target = editor;
                if (!target) return;
                target.setStyleForNextShapes(GeoShapeGeoStyle, option.geo);
                target.setCurrentTool("geo");
              }}
            >
              <OptionIcon />
              <span className="flex-1 truncate">{t(option.labelKey)}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 图片：5.4 没有 image 工具，所以这里开一次文件选择，把文件交给
 * `putExternalContent`——落点、上传、建 image shape 全归 content agent
 * 注册的外部内容处理器，Dock 只负责把文件递过去。
 */
function ImageToolButton({ disabled }: { disabled: boolean }) {
  const t = useT();
  const input = React.useRef<HTMLInputElement>(null);
  const Icon = IMAGE_TOOL.icon;

  return (
    <>
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <IconButton
            size="dock"
            label={t(IMAGE_TOOL.labelKey)}
            disabled={disabled}
            onClick={() => input.current?.click()}
          >
            <Icon />
          </IconButton>
        </TooltipTrigger>
        <TooltipContent>{t(IMAGE_TOOL.labelKey)}</TooltipContent>
      </Tooltip>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length === 0) return;
          void insertFiles(files);
        }}
      />
    </>
  );
}

/** 把文件塞进画布中心；`putExternalContent` 走的是与拖放、粘贴同一条路。 */
async function insertFiles(files: File[]): Promise<void> {
  const editor = getEditor();
  if (!editor) return;
  const center = editor.getViewportPageBounds().center;
  await editor.putExternalContent({
    type: "files",
    files,
    point: { x: center.x, y: center.y },
  });
}
