import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/icon-button";
import { StatusPill } from "@/ui/status-pill";
import { useT } from "@/app/preferences-store";
import { formatClock } from "@/lib/format";
import type { SubagentCardModel } from "@/agent/subagent-store";

export interface SubagentCardProps {
  card: SubagentCardModel;
}

/**
 * 子代理临时卡片（§3.4 / §5.9）。左侧 3px 陶土竖条 + 类型 + 任务名 +
 * 计时 + tokens/工具数；默认折叠，▸ 展开看结果。
 *
 * 数据来自 `agent/subagent-store`（`agent.subagent` 事件），既不入库也不进
 * 撤销。转录尾部不在事件里，所以展开显示的是子代理返回的 `result`——
 * 没有 `result` 就直说没有，而不是留一块空白。
 */
export function SubagentCard({ card }: SubagentCardProps) {
  const t = useT();
  const working = card.state === "working";
  const [now, setNow] = React.useState(() => Date.now());
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [working]);

  // 结束之后用回报的时长；还在跑就自己数秒。
  const elapsed = working
    ? Math.max(0, now - card.startedAt)
    : (card.durationMs ?? Math.max(0, now - card.startedAt));

  return (
    <div
      data-slot="subagent-card"
      aria-label={t("subagent.card")}
      className="flex w-full flex-col overflow-hidden rounded-[var(--r-card)] border border-border bg-[var(--card)] shadow-[var(--shadow-pill)]"
      style={{ borderLeft: "3px solid var(--agent-working)" }}
    >
      <div className="flex h-[28px] items-center gap-2 px-2">
        <StatusPill
          tone={working ? "working" : "unread"}
          label={t(working ? "subagent.working" : "subagent.done")}
        />
        {card.type && (
          <Badge
            variant="outline"
            className="h-[15px] shrink-0 px-1.5 text-[length:var(--text-caption)]"
          >
            {card.type}
          </Badge>
        )}
        <span className="truncate text-[11px] text-foreground">
          {card.taskLabel}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[length:var(--text-caption)] text-muted-foreground tabular-nums">
          {formatClock(elapsed)}
        </span>
        {typeof card.tokens === "number" && (
          <Badge
            variant="outline"
            className="h-[15px] shrink-0 px-1.5 text-[length:var(--text-caption)]"
          >
            {card.tokens} {t("subagent.tokens")}
          </Badge>
        )}
        {typeof card.toolUses === "number" && (
          <Badge
            variant="outline"
            className="h-[15px] shrink-0 px-1.5 text-[length:var(--text-caption)]"
          >
            {card.toolUses} {t("subagent.toolUses")}
          </Badge>
        )}
        {!working && (
          <IconButton
            className="size-[18px]"
            label={t(open ? "subagent.collapse" : "subagent.expand")}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronDown /> : <ChevronRight />}
          </IconButton>
        )}
      </div>
      {open && !working && (
        <pre className="max-h-[240px] overflow-auto border-t border-border px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
          {card.result ?? t("subagent.noResult")}
        </pre>
      )}
    </div>
  );
}
