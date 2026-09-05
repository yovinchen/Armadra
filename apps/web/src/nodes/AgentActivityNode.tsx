import * as React from "react";

import { Badge } from "@/ui/badge";
import { StatusPill } from "@/ui/status-pill";
import { useAgentStatus } from "@/agent/status-store";
import { useSubagentCards } from "@/agent/subagent-store";
import { useCanvasStore } from "@/store/canvas-store";
import { usePreferencesStore, useT } from "@/app/preferences-store";
import { NodeShell } from "./NodeShell";
import type { NodeBodyProps } from "./registry";

/**
 * 原生活动观察卡片（自动化设计 §3）。
 *
 * 只读：数据来自已有的 Hook 事件（agent status 与 subagent 事件），这张卡不
 * 暂停、不取消、也不触发任何执行——隐藏它不会动 CLI 自己的循环。它与
 * `automation` 是两种实体，互不转换，免得同一个任务被双重触发。
 */
export function AgentActivityNode({ id, node, selected }: NodeBodyProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const data = node.data.kind === "agentActivity" ? node.data : null;
  const sourceId = data?.sourceNodeId ?? "";
  const source = useCanvasStore((state) =>
    state.document?.nodes.find((candidate) => candidate.id === sourceId),
  );
  const status = useAgentStatus(sourceId);
  const cards = useSubagentCards(sourceId);

  // Both sources read the same Hook stream; the label says which lens it is.
  // Nothing is synthesised here — a CLI whose loop we cannot observe shows zero.
  const latest = cards[cards.length - 1];
  const clock = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { timeStyle: "medium" }),
    [locale],
  );

  return (
    <NodeShell
      node={node}
      selected={selected}
      headerChips={
        <Badge variant="outline">
          {t(`activity.source.${data?.source ?? "loop"}`)}
        </Badge>
      }
      {...(status?.state === "working" ? { glow: "working" as const } : {})}
    >
      <div
        data-slot="agent-activity-card"
        data-node-id={id}
        className="min-w-0 space-y-2 px-3 py-2 text-[12px]"
      >
        {!source ? (
          <p role="status" className="text-muted-foreground">
            {t("activity.missingSource")}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill
                tone={status?.state === "working" ? "working" : "unread"}
                label={t("activity.readOnly")}
              />
              <span className="min-w-0 truncate font-medium">
                {source.title}
              </span>
            </div>
            <p className="text-muted-foreground">
              {t("activity.iterations", { count: cards.length })}
            </p>
            {latest ? (
              <div className="min-w-0 space-y-1">
                <p className="text-muted-foreground">{t("activity.latest")}</p>
                <p className="min-w-0 truncate">{latest.taskLabel}</p>
                <p className="text-[11px] text-muted-foreground">
                  {clock.format(latest.startedAt)}
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground">{t("activity.none")}</p>
            )}
            <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {data?.sessionId ? (
                <>
                  <dt>{t("activity.session")}</dt>
                  <dd className="min-w-0 truncate select-text">
                    {data.sessionId}
                  </dd>
                </>
              ) : null}
              {data?.nativeJobId ? (
                <>
                  <dt>{t("activity.job")}</dt>
                  <dd className="min-w-0 truncate select-text">
                    {data.nativeJobId}
                  </dd>
                </>
              ) : null}
              {data && data.generation > 0 ? (
                <>
                  <dt>{t("activity.generation")}</dt>
                  <dd className="min-w-0 truncate">{data.generation}</dd>
                </>
              ) : null}
            </dl>
            <p className="text-[11px] text-muted-foreground">
              {t("activity.hideOnly")}
            </p>
          </>
        )}
      </div>
    </NodeShell>
  );
}
