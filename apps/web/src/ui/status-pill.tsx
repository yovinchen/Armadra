import * as React from "react";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";

/**
 * 状态胶囊（§3.4，形状按 §24.3-3 重做）。节点头部、会话行、子代理卡片共用。
 *
 * 它是 shadcn `Badge` 的一层薄封装：11px / medium / 圆角 6 / 前置 6px 圆点，
 * 不再强制全大写也不加字距——文案由调用方经 i18n 给出，中文加字距会散架。
 * 颜色按 tone 从 `--status-*` token 取，所以两套主题自动跟随。
 *
 * `pulse` 的呼吸动画在 `prefers-reduced-motion` 下会被 tokens.css 压掉，
 * 因此状态永远同时由“文字 + 颜色”表达，不靠动画传递信息。
 */
export type StatusTone =
  | "working"
  | "attention"
  | "failed"
  | "queued"
  | "paused"
  | "unread"
  | "idle";

const TONE_COLOR: Record<StatusTone, string> = {
  working: "var(--status-working)",
  attention: "var(--status-attention)",
  failed: "var(--status-failed)",
  queued: "var(--status-queued)",
  paused: "var(--status-paused)",
  unread: "var(--status-unread)",
  idle: "var(--status-idle)",
};

/**
 * 兜底文案：界面里的胶囊一律由调用方传 `t(...)` 的本地化串，
 * 这里只是给测试与非本地化调用点一个可读的默认值（首字母大写，不全大写）。
 */
export const STATUS_PILL_LABELS: Record<StatusTone, string> = {
  working: "Running",
  attention: "Needs you",
  failed: "Turn failed",
  queued: "Queued",
  paused: "Paused",
  unread: "Unread",
  idle: "Idle",
};

/** 默认会脉冲的两种状态：正在跑、需要你。其余静止（§3.4）。 */
export const STATUS_PILL_PULSES: Record<StatusTone, boolean> = {
  working: true,
  attention: true,
  failed: false,
  queued: false,
  paused: false,
  unread: false,
  idle: false,
};

export interface StatusPillProps extends React.ComponentProps<"span"> {
  tone: StatusTone;
  label: React.ReactNode;
  /** 圆点是否呼吸。不传时按 `STATUS_PILL_PULSES` 取默认。 */
  pulse?: boolean;
  /** 尾随内容，例如队列状态的 ▶。 */
  trailing?: React.ReactNode;
}

export function StatusPill({
  tone,
  label,
  pulse,
  trailing,
  className,
  style,
  ...props
}: StatusPillProps) {
  const color = TONE_COLOR[tone];
  const shouldPulse = pulse ?? STATUS_PILL_PULSES[tone];
  return (
    <Badge
      variant="secondary"
      data-slot="status-pill"
      data-tone={tone}
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
        ...style,
      }}
      className={cn(
        "h-[18px] gap-1 rounded-[var(--r-control)] px-1.5 py-0",
        "text-[length:var(--text-caption)] leading-[16px] font-medium",
        className,
      )}
      {...props}
    >
      <span
        data-slot="status-pill-dot"
        aria-hidden
        style={{ backgroundColor: color }}
        className={cn(
          "size-[6px] shrink-0 rounded-full",
          shouldPulse && "anim-dot-pulse",
        )}
      />
      {label}
      {trailing}
    </Badge>
  );
}
