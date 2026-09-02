import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * 应用品牌标识。桌面图标、Web favicon 与界面内标识共用同一张源图，
 * 避免不同入口出现不同的 Logo。
 */
export function BrandMark({
  className,
  ...props
}: Omit<React.ComponentProps<"img">, "src" | "alt">) {
  return (
    <img
      src="/icon.png"
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn("shrink-0", className)}
      {...props}
    />
  );
}
