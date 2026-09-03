import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * 设置页里的一张分组卡片（§24.2「分组表单」）。
 *
 * 卡片 `rounded-xl` + 1px 边框 + `--card` 底；内部的行由 `divide-y` 分隔，
 * 所以行本身不再各画一条线。可选的 `title` 是 11px 大写小标题，只在一页里
 * 有多张卡片、需要区分时才给。
 */
export function SettingsGroup({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      {title && (
        <h3 className="px-1 text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
          {title}
        </h3>
      )}
      <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-card">
        {children}
      </div>
    </section>
  );
}
