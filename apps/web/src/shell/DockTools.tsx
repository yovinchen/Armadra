import * as React from "react";
import { Shapes } from "lucide-react";

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
import { useCompactLayout } from "@/platform/layout";
import { runCanvasCommand } from "@/canvas/commands";
import { pickFilesForCanvas } from "@/canvas/dnd/external-content";
import { useFlowHandle } from "@/canvas/flow/flow-context";
import {
  getNextStyle,
  setNextStyle,
  useNextStyle,
  useTool,
} from "@/canvas/interaction/tool-store";
import {
  CANVAS_TOOLS,
  GEO_OPTIONS,
  IMAGE_TOOL,
  PHONE_TOOL_IDS,
  geoIcon,
  isToolDisabledWhenLocked,
  type CanvasToolSpec,
} from "@/canvas/tools";
import { commandKeysLabel, type CommandId } from "@/keybindings";

/**
 * Dock 的白板工具组（React Flow 计划 F21）。
 *
 * 高亮跟着 `interaction/tool-store` 走，点击只发画布命令——真正的
 * `setTool` 在 `FlowWorkspace` 里注册，所以快捷键、命令面板、这一排按钮
 * 走的是同一条路径。
 *
 * 画布没挂载（启动页）时整组不渲染：没有画布就没有工具可切。
 *
 * 置灰只剩一条规则：锁定视图时除「选择」之外全部禁用
 * （`tools.isToolDisabledWhenLocked`）。
 *
 * 手机（`isCompactLayout()`，≤ 767px）上只留选择与手（F32）：手指画不出
 * 能用的墨迹，而每多一个按钮，390px 宽的 Dock 就少一分能按得中的余量。
 * 图片按钮同样收起——它开的是系统文件选择器，手机上那条路不通。
 */
export function DockTools() {
  const t = useT();
  const flow = useFlowHandle();
  const locked = useCanvasLocked();
  const currentTool = useTool();
  const phone = useCompactLayout();

  if (!flow) return null;

  const disabled = (id: string) => locked && isToolDisabledWhenLocked(id);
  const tools = phone
    ? CANVAS_TOOLS.filter((tool) => PHONE_TOOL_IDS.includes(tool.id))
    : CANVAS_TOOLS;

  const buttons = (
    <>
      {tools.map((tool) =>
        tool.id === "geo" ? (
          <GeoToolButton
            key={tool.id}
            tool={tool}
            active={currentTool === "geo"}
            disabled={disabled(tool.id)}
          />
        ) : (
          <ToolButton
            key={tool.id}
            tool={tool}
            active={currentTool === tool.id}
            disabled={disabled(tool.id)}
          />
        ),
      )}
      {phone ? null : <ImageToolButton disabled={locked} />}
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
 * 形状按钮：点开就切到形状工具，菜单里挑的是「下一个对象」的几何形，
 * 所以按钮图标、样式面板里的形状选择器、下一个画出来的对象永远一致。
 */
function GeoToolButton({ tool, active, disabled }: ToolButtonProps) {
  const t = useT();
  const geo = useNextStyle().geo;
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
                if (getNextStyle().geo !== option.geo) {
                  setNextStyle({ geo: option.geo });
                }
                runCanvasCommand(tool.command);
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
 * 图片：不是工具，所以这里开一次文件选择，把文件交给外部内容处理器
 * （`dnd/external-content.pickFilesForCanvas`）。落点是视口中心。
 */
function ImageToolButton({ disabled }: { disabled: boolean }) {
  const t = useT();
  const Icon = IMAGE_TOOL.icon;
  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <IconButton
          size="dock"
          label={t(IMAGE_TOOL.labelKey)}
          disabled={disabled}
          onClick={() => pickFilesForCanvas()}
        >
          <Icon />
        </IconButton>
      </TooltipTrigger>
      <TooltipContent>{t(IMAGE_TOOL.labelKey)}</TooltipContent>
    </Tooltip>
  );
}
