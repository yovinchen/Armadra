import * as React from "react";
import { cn } from "@/lib/cn";

export interface ColorDotProps extends React.ComponentProps<"span"> {
  color: string;
  /** 直径（px）。用于状态提示和白板绘图调色板。 */
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
