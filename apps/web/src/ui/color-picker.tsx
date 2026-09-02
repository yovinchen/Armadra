import * as React from "react";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import {
  ColorDot,
  NODE_COLORS,
  NODE_COLOR_LABEL_KEYS,
  type NodeColor,
} from "@/ui/color-dot";
import { useT } from "@/app/preferences-store";

/**
 * 7 色调色板 Popover（§3.4：点击节点头部色点弹出）。
 *
 * 用一行 `role="radiogroup"` 而不是菜单：色块之间用左右方向键移动更自然，
 * 也让屏幕阅读器把它读成一组互斥选项。
 */
export interface ColorPickerProps {
  value?: string;
  onChange: (color: NodeColor) => void;
  children: React.ReactNode;
  align?: React.ComponentProps<typeof PopoverContent>["align"];
  side?: React.ComponentProps<typeof PopoverContent>["side"];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ColorPicker({
  value,
  onChange,
  children,
  align = "start",
  side,
  open,
  onOpenChange,
}: ColorPickerProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} side={side} className="w-auto p-1.5">
        <ColorSwatches value={value} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}

/** 不带 Popover 的裸色板，设置页 / 右键菜单子项里直接用。 */
export function ColorSwatches({
  value,
  onChange,
  className,
}: {
  value?: string;
  onChange: (color: NodeColor) => void;
  className?: string;
}) {
  const t = useT();
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  function handleKeyDown(event: React.KeyboardEvent, index: number) {
    const delta =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (index + delta + NODE_COLORS.length) % NODE_COLORS.length;
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={t("color.palette")}
      className={cn("flex items-center gap-0.5", className)}
    >
      {NODE_COLORS.map((color, index) => {
        const selected = value === color;
        return (
          <Button
            key={color}
            ref={(node: HTMLButtonElement | null) => {
              refs.current[index] = node;
            }}
            variant="ghost"
            size="icon-sm"
            role="radio"
            aria-checked={selected}
            aria-label={t(NODE_COLOR_LABEL_KEYS[color])}
            title={t(NODE_COLOR_LABEL_KEYS[color])}
            // 只有选中项进 Tab 序，组内靠方向键移动
            tabIndex={selected || (!value && index === 0) ? 0 : -1}
            onClick={() => onChange(color)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            <ColorDot color={color} size={14} selected={selected} />
          </Button>
        );
      })}
    </div>
  );
}
