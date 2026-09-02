import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * 节点调色板（§3.4）。7 色是白名单：画布控制 API 的 `color` 动词
 * 只接受这 7 个值，所以这里是前端侧的唯一真相。
 */
export const NODE_COLORS = [
  "#0a84ff",
  "#32d74b",
  "#ffd60a",
  "#ff453a",
  "#bf5af2",
  "#6ac4dc",
  "#ff9f0a",
] as const;

export type NodeColor = (typeof NODE_COLORS)[number];

/**
 * 每个色值对应的 i18n 键（`i18n/nodes.ts` 的 `color.*`）。
 * 这里只存键：色板的无障碍名要跟着语言走，而这张表是模块级常量。
 */
export const NODE_COLOR_LABEL_KEYS: Record<NodeColor, string> = {
  "#0a84ff": "color.blue",
  "#32d74b": "color.green",
  "#ffd60a": "color.yellow",
  "#ff453a": "color.red",
  "#bf5af2": "color.purple",
  "#6ac4dc": "color.cyan",
  "#ff9f0a": "color.orange",
};

export function isNodeColor(value: string): value is NodeColor {
  return (NODE_COLORS as readonly string[]).includes(value);
}

export interface ColorDotProps extends React.ComponentProps<"span"> {
  color: string;
  /** 直径（px）。节点头部用 12，会话行用 8。 */
  size?: number;
  /** 选中时在外面画一圈同色描边（中间留一圈底色做隔离）。 */
  selected?: boolean;
}

export function ColorDot({
  color,
  size = 12,
  selected = false,
  className,
  style,
  ...props
}: ColorDotProps) {
  return (
    <span
      data-slot="color-dot"
      aria-hidden
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        boxShadow: selected
          ? `0 0 0 2px var(--popover), 0 0 0 3.5px ${color}`
          : undefined,
        ...style,
      }}
      className={cn("inline-block shrink-0 rounded-full", className)}
      {...props}
    />
  );
}
