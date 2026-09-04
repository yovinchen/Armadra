import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";

/**
 * 一行设置：左标签（13px）/ 右控件，行高 44（§24.1 + §24.2 的 8pt 网格）。
 *
 * `footnote` 是 ChatGPT 那种 11px 灰色脚注：**只有必须解释后果的行**才给，
 * 每张卡片最多一条（§14 第 1 条的例外）。
 *
 * `onClick` 把**标签那一半**变成按钮并在末尾补一个 `›`（用于「点进子页」的
 * 行）。刻意不把整行做成 `<button>`：这些行右边常常还有自己的按钮，套在
 * 一个按钮里既不合法也点不准。
 */
export function SettingsRow({
  label,
  footnote,
  children,
  onClick,
  className,
}: {
  /** `null` = 只有动作按钮的一行（左对齐，不重复写一遍按钮上的字）。 */
  label: ReactNode | null;
  footnote?: string;
  children?: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const text = (
    <span className="flex min-w-0 flex-col gap-0.5 text-left">
      <span className="break-words text-[13px] leading-5 text-foreground">
        {label}
      </span>
      {footnote && (
        <span className="text-[11px] leading-4 text-muted-foreground">
          {footnote}
        </span>
      )}
    </span>
  );

  return (
    <div
      className={cn(
        "settings-row flex min-h-12 w-full items-center gap-4 px-4 py-3",
        label === null ? "justify-start" : "justify-between",
        className,
      )}
    >
      {label === null ? null : onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="-mx-1 flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-1 py-1 transition-colors hover:bg-muted/50"
        >
          {text}
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </button>
      ) : (
        text
      )}
      <div className="settings-row-controls flex max-w-full shrink-0 items-center gap-2">
        {children}
      </div>
    </div>
  );
}
