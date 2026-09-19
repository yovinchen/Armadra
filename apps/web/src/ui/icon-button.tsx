import * as React from "react";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";

/**
 * 纯图标按钮。三种尺寸对应界面里三个固定位置（§24.2「克制的图标与文字」）：
 *
 * - `cluster` 28×28、图标 16px：工具簇与浮层标题行的按钮。
 *   自己不带底色——它总是坐在一条 `--panel` 的条子里，底色由那条给。
 * - `dock` 32×32、图标 18px：底部 Dock 的按钮（Dock 高 44，留 6px 内边距）。
 * - `inline` 24×24、图标 14px：节点头部右侧的 ⟳ / 最大化 / ×（§3.4），
 *   以及抽屉标题行里的小动作。2026-09-19 从 26 收到 24：头部只有 30px 高，
 *   26 的钮几乎顶满，留不出可读的上下留白。
 *
 * 它只是 shadcn `Button` 的尺寸/底色预设——变体逻辑、焦点环、disabled
 * 行为全部沿用生成的 Button。
 *
 * 图标按钮没有可见文字，所以 `label` 是必填的，会写进 `aria-label`。
 * 悬停提示请在外面套 `Tooltip`，避免每个按钮都强绑一个 TooltipProvider。
 */
export interface IconButtonProps
  extends Omit<React.ComponentProps<typeof Button>, "aria-label" | "size"> {
  /** 无障碍名称，必填。 */
  label: string;
  size?: "cluster" | "dock" | "inline";
  /** 处于激活/开启状态（例如已 pin 的抽屉、已锁定的相机）。 */
  active?: boolean;
}

export function IconButton({
  className,
  size = "inline",
  variant,
  label,
  active,
  ...props
}: IconButtonProps) {
  const preset = {
    cluster: [
      "size-[28px] rounded-[var(--r-control)] text-muted-foreground",
      "hover:bg-[var(--hover)] hover:text-foreground",
      "data-[active=true]:bg-[color-mix(in_srgb,var(--brand)_15%,transparent)]",
      "data-[active=true]:text-[var(--brand)]",
      "[&_svg:not([class*='size-'])]:size-4 [&_svg]:[stroke-width:1.5]",
    ],
    dock: [
      "size-[32px] rounded-[var(--r-md)] text-muted-foreground",
      "hover:bg-[var(--hover)] hover:text-foreground",
      "data-[active=true]:bg-[color-mix(in_srgb,var(--brand)_15%,transparent)]",
      "data-[active=true]:text-[var(--brand)]",
      "[&_svg:not([class*='size-'])]:size-[18px] [&_svg]:[stroke-width:1.5]",
    ],
    inline: [
      "size-[24px] rounded-[var(--r-control)] text-muted-foreground",
      "data-[active=true]:bg-accent data-[active=true]:text-accent-foreground",
      "[&_svg:not([class*='size-'])]:size-3.5 [&_svg]:[stroke-width:1.5]",
    ],
  }[size];

  return (
    <Button
      data-slot="icon-button"
      data-active={active ? "true" : undefined}
      aria-label={label}
      aria-pressed={active}
      variant={variant ?? "ghost"}
      size="icon"
      className={cn("motion-hover", preset, className)}
      {...props}
    />
  );
}
