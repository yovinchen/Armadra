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
  useToolGroupChoice,
  type CanvasToolId,
} from "@/canvas/interaction/tool-store";
import {
  DOCK_TOOL_ITEMS,
  GEO_OPTIONS,
  IMPORT_TOOL,
  PHONE_DOCK_TOOL_ITEMS,
  TOOL_BY_ID,
  geoIcon,
  isToolDisabledWhenLocked,
  type CanvasToolSpec,
  type DockToolItem,
} from "@/canvas/tools";
import { commandKeysLabel, type CommandId } from "@/keybindings";
import { useMenuTooltip } from "./menu-tooltip";

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
 * 同一件事的两种口味合成一格（2026-09-21 用户反馈：十个按钮里一半是成对
 * 的）：笔（画笔 / 高亮）、线（直线 / 箭头）各一格，做法与形状那一格一样，
 * 按钮显示当前成员、下拉换另一种。记忆在 `tool-store` 的
 * `useToolGroupChoice`，所以快捷键切过去之后图标也跟着变。
 *
 * 手机（`isCompactLayout()`，≤ 767px）上只留选择与手（F32）：手指画不出
 * 能用的墨迹，而每多一个按钮，390px 宽的 Dock 就少一分能按得中的余量。
 * 引入按钮同样收起——它开的是系统文件选择器，手机上那条路不通。
 */
export function DockTools() {
  const t = useT();
  const flow = useFlowHandle();
  const locked = useCanvasLocked();
  const currentTool = useTool();
  const phone = useCompactLayout();

  if (!flow) return null;

  const disabled = (id: string) => locked && isToolDisabledWhenLocked(id);
  const items = phone ? PHONE_DOCK_TOOL_ITEMS : DOCK_TOOL_ITEMS;

  const buttons = (
    <>
      {items.map((item) => (
        <DockToolSlot
          key={item.kind === "group" ? item.group : item.tool.id}
          item={item}
          currentTool={currentTool}
          disabled={disabled}
        />
      ))}
      {phone ? null : <ImportToolButton disabled={locked} />}
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

function DockToolSlot({
  item,
  currentTool,
  disabled,
}: {
  item: DockToolItem;
  currentTool: CanvasToolId;
  disabled: (id: string) => boolean;
}) {
  // hooks 不能挂在分支里，所以这一格的三种形态各自是一个组件。
  if (item.kind === "geo") {
    return (
      <GeoToolButton
        tool={item.tool}
        active={currentTool === item.tool.id}
        disabled={disabled(item.tool.id)}
      />
    );
  }
  if (item.kind === "group") {
    return (
      <ToolGroupButton
        item={item}
        currentTool={currentTool}
        disabled={disabled}
      />
    );
  }
  return (
    <ToolButton
      tool={item.tool}
      active={currentTool === item.tool.id}
      disabled={disabled(item.tool.id)}
    />
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
  const menu = useMenuTooltip(
    React.useCallback(
      (open: boolean) => {
        if (open) runCanvasCommand(tool.command);
      },
      [tool.command],
    ),
  );

  return (
    <DropdownMenu {...menu.menuProps}>
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild {...menu.tooltipTriggerProps}>
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
        {/* 菜单展开时不再挂提示：它会压在第一条菜单项上。 */}
        {menu.menuOpen ? null : (
          <TooltipContent>
            {toolTooltip(tool.labelKey, tool.command, t)}
          </TooltipContent>
        )}
      </Tooltip>
      <DropdownMenuContent
        align="center"
        side="top"
        className="z-[var(--z-menu)] w-auto min-w-40"
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
 * 笔 / 线那一格：按钮**就是**组里当前那个工具——图标、名字、键位都是它的，
 * 点一下等于按它的快捷键；下拉里换成另一种，换完 `setTool` 把选择记进
 * `tool-store`，所以下次这一格显示的还是它。
 *
 * 与形状那一格的差别只在下拉里挑的是什么：形状挑 `nextStyle.geo`（工具不
 * 变），这里挑的是工具本身。
 */
function ToolGroupButton({
  item,
  currentTool,
  disabled,
}: {
  item: Extract<DockToolItem, { kind: "group" }>;
  currentTool: CanvasToolId;
  disabled: (id: string) => boolean;
}) {
  const t = useT();
  const current = TOOL_BY_ID[useToolGroupChoice()[item.group]];
  const Icon = current.icon;
  const menu = useMenuTooltip(
    React.useCallback(
      (open: boolean) => {
        if (open) runCanvasCommand(current.command);
      },
      [current.command],
    ),
  );
  const active = item.members.some((member) => member.id === currentTool);

  return (
    <DropdownMenu {...menu.menuProps}>
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild {...menu.tooltipTriggerProps}>
          <DropdownMenuTrigger asChild>
            <IconButton
              size="dock"
              label={t(current.labelKey)}
              active={active}
              disabled={disabled(current.id)}
            >
              <Icon />
            </IconButton>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {menu.menuOpen ? null : (
          <TooltipContent>
            {toolTooltip(current.labelKey, current.command, t)}
          </TooltipContent>
        )}
      </Tooltip>
      <DropdownMenuContent
        align="center"
        side="top"
        className="z-[var(--z-menu)] w-auto min-w-40"
      >
        {item.members.map((member) => {
          const MemberIcon = member.icon;
          return (
            <DropdownMenuItem
              key={member.id}
              data-checked={current.id === member.id ? "true" : undefined}
              onSelect={() => runCanvasCommand(member.command)}
            >
              <MemberIcon />
              <span className="flex-1 truncate">{t(member.labelKey)}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 引入：不是工具，所以这里开一次文件选择，把文件交给外部内容处理器
 * （`dnd/external-content.pickFilesForCanvas`）。落点是视口中心。
 *
 * 文件选择器不设 `accept`：图片落成白板图片对象、其余落成文件节点，两条路
 * 都在 `external-content.ts` 里，挡掉非图片等于关掉后一条。
 */
function ImportToolButton({ disabled }: { disabled: boolean }) {
  const t = useT();
  const Icon = IMPORT_TOOL.icon;
  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <IconButton
          size="dock"
          label={t(IMPORT_TOOL.labelKey)}
          disabled={disabled}
          onClick={() => pickFilesForCanvas()}
        >
          <Icon />
        </IconButton>
      </TooltipTrigger>
      <TooltipContent>{t(IMPORT_TOOL.labelKey)}</TooltipContent>
    </Tooltip>
  );
}
