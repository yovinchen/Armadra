import { useInfiniteQuery } from "@tanstack/react-query";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { useT } from "@/app/preferences-store";
import { instant, reasonLabel, receiptPhase, runStateKey } from "./model";
import { automationKeys, runPage } from "./queries";
import { AutomationApi, AutomationPlanSnapshot } from "../../api/automations";

export interface RunHistoryProps {
  client: AutomationApi;
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
 *
 * 分页由 Host 做，游标就是时间上的位置，所以「加载更早」拿到的确实是更早的
 * 那一页——而不是先把全部翻回来再在本地排一遍。第一页之外的记录只在有人要看
 * 的时候才请求。
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
  const runs = useInfiniteQuery({
    queryKey: automationKeys.runs(workspaceId, planId ?? ""),
    queryFn: ({ pageParam }) => runPage(client, planId!, pageParam),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(planId),
    retry: false,
  });
  const rows = runs.data?.pages.flatMap((page) => page.runs) ?? [];

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

      {runs.isSuccess && rows.length === 0 && (
        <p className="text-[12px] text-muted-foreground">
          {t("automation.emptyRuns")}
        </p>
      )}

      {rows.map(({ run }) =>
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

      {/*
        显式的「加载更早」，不是滚到底自动拉：翻页会打 Host，而一个正在读的人
        不该因为滚过了头就替他发一串请求。
      */}
      {runs.hasNextPage && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="min-h-10 w-full"
          data-slot="automation-runs-more"
          disabled={runs.isFetchingNextPage}
          onClick={() => void runs.fetchNextPage()}
        >
          {t(
            runs.isFetchingNextPage
              ? "automation.runs.loading"
              : "automation.runs.more",
          )}
        </Button>
      )}
    </div>
  );
}
