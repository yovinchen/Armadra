import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { RotateCw, X } from "lucide-react";
import type { HandoffView } from "@armadra/shared";

import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/icon-button";
import { ScrollArea } from "@/ui/scroll-area";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { runtimeApi } from "@/api/client";
import { usePreferencesStore, useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";

/**
 * 工作空间的交接历史（自动化设计 §7）。
 *
 * 三条规矩：
 *
 *  1. 来源与目标读的是**冻结在包里**的身份，不重新解析当前画布。节点被删掉
 *     之后，这条记录仍然要说清当时那次交接发生在谁和谁之间。
 *  2. 「已投递」和「已确认」分开显示，`unknownOutcome` 自成一行——写进输入框
 *     不等于对方读过或做完，写入结果未知更不等于失败。
 *  3. 重试次数是投递门认领的次数，不是成功次数：目标忙、前台不是那个 Agent
 *     都会把通知退回队列，只看状态分不出第一次和第二十次。
 */
export function HandoffHistoryDrawer() {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const mode = useCanvasStore((state) => state.panels.handoff);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const workspace = useCanvasStore((state) => state.workspace);
  const open = mode === "drawer";
  const workspaceId = workspace?.id ?? null;

  const history = useQuery({
    queryKey: ["handoffs", "workspace", workspaceId ?? ""],
    queryFn: ({ signal }) => runtimeApi.workspaceHandoffs(workspaceId!, signal),
    enabled: open && Boolean(workspaceId),
    retry: false,
  });

  const clock = React.useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "short",
        timeStyle: "short",
      }),
    [locale],
  );
  const at = (value: string | null) => {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? clock.format(parsed) : "—";
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setPanel("handoff", "closed");
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        className="max-w-full gap-0 p-0 data-[side=right]:w-[min(100vw,var(--scm-w))] data-[side=right]:sm:max-w-none"
      >
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
          <SheetTitle className="shrink-0 truncate text-[13px] font-semibold">
            {t("handoff.historyTitle")}
          </SheetTitle>
          <div className="flex-1" />
          <IconButton
            label={t("handoff.reload")}
            onClick={() => void history.refetch()}
          >
            <RotateCw />
          </IconButton>
          <IconButton
            label={t("handoff.close")}
            onClick={() => setPanel("handoff", "closed")}
          >
            <X />
          </IconButton>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="min-w-0 space-y-2 p-3">
            {!workspaceId && (
              <p role="status" className="text-[12px] text-muted-foreground">
                {t("handoff.noWorkspace")}
              </p>
            )}
            {history.isError && (
              <p role="status" className="text-[12px] text-destructive">
                {t("handoff.historyFailed")}
              </p>
            )}
            {history.isSuccess && history.data.length === 0 && (
              <p className="text-[12px] text-muted-foreground">
                {t("handoff.noHistory")}
              </p>
            )}
            {history.data?.map((view) => (
              <HandoffRow key={view.bundle.handoffId} view={view} at={at} />
            ))}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function HandoffRow({
  view,
  at,
}: {
  view: HandoffView;
  at: (value: string | null) => string;
}) {
  const t = useT();
  const { source, target } = view.bundle;
  // A machine token, shown verbatim: translating it would make two different
  // refusals read the same.
  const reason = view.errorCode ?? "";
  return (
    <div
      data-slot="handoff-history-row"
      data-state={view.state}
      className="min-w-0 space-y-1 rounded-md border border-border p-2 text-[12px]"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant="outline">{t(`handoff.${view.state}`)}</Badge>
        <span className="min-w-0 truncate font-medium">
          {source.nodeTitle || source.agentId}
        </span>
        <span aria-hidden className="text-muted-foreground">
          →
        </span>
        <span className="min-w-0 truncate font-medium">
          {target.nodeTitle || target.agentId}
        </span>
      </div>
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <dt>{t("handoff.historyAgents")}</dt>
        <dd className="min-w-0 truncate">
          {source.agentId} → {target.agentId}
        </dd>
        <dt>{t("handoff.historyCreated")}</dt>
        <dd>{at(view.bundle.createdAt)}</dd>
        <dt>{t("handoff.historyUpdated")}</dt>
        <dd>{at(view.updatedAt)}</dd>
        <dt>{t("handoff.historyAttempts")}</dt>
        <dd>{view.attempts}</dd>
        {view.outboxState ? (
          <>
            <dt>{t("handoff.historyQueue")}</dt>
            <dd>{view.outboxState}</dd>
          </>
        ) : null}
        {reason ? (
          <>
            <dt>{t("handoff.historyReason")}</dt>
            <dd className="min-w-0 truncate select-text">{reason}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
