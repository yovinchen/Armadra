import { cn } from "@/lib/cn";

/**
 * 侧栏里那颗 6px 的点（§26）。
 *
 * 两种语气：`attention` 是红的（Agent 在等你），`unread` 是蓝的（跑完了但
 * 没看过）。铃铛与折叠钮上的那颗用 `corner` 贴到图标右上角。
 */
export function SignalDot({
  tone,
  corner,
  label,
}: {
  tone: "attention" | "unread";
  corner?: boolean;
  label: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "block size-1.5 shrink-0 rounded-full",
        corner &&
          "pointer-events-none absolute top-[5px] right-[5px] ring-2 ring-[var(--panel)]",
      )}
      style={{
        background: tone === "attention" ? "var(--danger)" : "var(--brand)",
      }}
    />
  );
}
