import { useQuery } from "@tanstack/react-query";
import type {
  AutomationPlanSnapshot,
  HostAutomationClient,
} from "@armadra/host-client";

import { Badge } from "@/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { useT } from "@/app/preferences-store";
import { instant, reasonLabel, receiptPhase, runStateKey } from "./model";
import { automationKeys, planRuns } from "./queries";

export interface RunHistoryProps {
  client: HostAutomationClient;
  workspaceId: string;
  plans: AutomationPlanSnapshot[];
  planId: string | null;
  locale: string;
  onSelect: (planId: string) => void;
}

/**
 * 运行历史。
 *
 * 每条记录都带收据阶段与派发次数：投递过和执行完是两回事，未知结果也单独
 * 成一行，不会被归进成功或失败。reasonCode 原样显示。
 */
export function RunHistory({
  client,
  workspaceId,
  plans,
  planId,
  locale,
  onSelect,
}: RunHistoryProps) {
  const t = useT();
  const runs = useQuery({
    queryKey: automationKeys.runs(workspaceId, planId ?? ""),
    queryFn: () => planRuns(client, planId!),
    enabled: Boolean(planId),
    retry: false,
  });

  return (
    <div className="min-w-0 space-y-3 p-3">
      <Select value={planId ?? ""} onValueChange={onSelect}>
        <SelectTrigger size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="z-[var(--z-dialog)]">
          {plans.map((snapshot) => (
            <SelectItem key={snapshot.plan!.id} value={snapshot.plan!.id}>
              {snapshot.plan?.config?.title || snapshot.plan!.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {runs.isSuccess && runs.data.length === 0 && (
        <p className="text-[12px] text-muted-foreground">
          {t("automation.emptyRuns")}
        </p>
      )}

      {runs.data?.map(({ run }) =>
        !run ? null : (
          <section
            key={run.id}
            data-slot="automation-run"
            data-run-id={run.id}
            className="min-w-0 space-y-1 rounded-lg border border-border px-3 py-2 text-[12px]"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge variant="secondary">{t(runStateKey(run))}</Badge>
              <Badge variant="outline">
                {t(`automation.receipt.${receiptPhase(run)}`)}
              </Badge>
              {run.misfire && (
                <Badge variant="ghost">{t("automation.run.misfire")}</Badge>
              )}
            </div>
            <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">
                {t("automation.run.scheduled")}
              </dt>
              <dd className="min-w-0 truncate">
                {instant(run.scheduledAtUnixMs, locale) ??
                  t("automation.unknownTime")}
              </dd>
              <dt className="text-muted-foreground">
                {t("automation.run.completed")}
              </dt>
              <dd className="min-w-0 truncate">
                {instant(run.completedAtUnixMs, locale) ??
                  t("automation.unknownTime")}
              </dd>
              <dt className="text-muted-foreground">
                {t("automation.run.attempts")}
              </dt>
              <dd className="tabular-nums">{run.dispatchAttempts}</dd>
              {reasonLabel(run.reasonCode) ? (
                <>
                  <dt className="text-muted-foreground">
                    {t("automation.run.reason")}
                  </dt>
                  <dd className="min-w-0 truncate font-mono text-[11px] select-text">
                    {reasonLabel(run.reasonCode)}
                  </dd>
                </>
              ) : null}
            </dl>
          </section>
        ),
      )}
    </div>
  );
}
