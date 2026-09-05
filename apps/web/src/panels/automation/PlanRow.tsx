import * as React from "react";
import type { AutomationPlanSnapshot } from "@armadra/host-client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { useT } from "@/app/preferences-store";
import { digestLabel, instant, planStateKey, scheduleKind } from "./model";

export interface PlanRowProps {
  snapshot: AutomationPlanSnapshot;
  locale: string;
  canManage: boolean;
  busy: boolean;
  /** True when this board already shows a card for the plan. */
  hasCard: boolean;
  onActivate: () => void;
  onPause: () => void;
  onRunNow: () => void;
  onViewRuns: () => void;
  onShowOnCanvas: () => void;
  onDetach: () => void;
  onDisableAndDetach: () => void;
}

const ACTIVE = 2;

/**
 * 计划列表里的一行。
 *
 * 启用和立即运行都要确认，确认框里显示这一版的 revision 与 config sha——
 * 启用绑定的就是用户看到的这一份，不是「最新的那一份」。
 * 「移除展示」与「停用并移除」是两个动作，永远不合并成一个按钮。
 */
export function PlanRow({
  snapshot,
  locale,
  canManage,
  busy,
  hasCard,
  onActivate,
  onPause,
  onRunNow,
  onViewRuns,
  onShowOnCanvas,
  onDetach,
  onDisableAndDetach,
}: PlanRowProps) {
  const t = useT();
  const [confirm, setConfirm] = React.useState<"activate" | "runNow" | null>(
    null,
  );
  const plan = snapshot.plan;
  if (!plan) return null;
  const kind = scheduleKind(plan.config);
  const zone =
    plan.config?.schedule?.kind?.case === "cron"
      ? plan.config.schedule.kind.value.timezone
      : undefined;
  const digest = digestLabel(snapshot.configSha256);

  return (
    <section
      data-slot="automation-plan"
      data-plan-id={plan.id}
      className="min-w-0 space-y-2 rounded-lg border border-border px-3 py-2"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {plan.config?.title || plan.id}
        </h3>
        <Badge variant="secondary">{t(planStateKey(plan))}</Badge>
        <Badge variant="outline">
          {t(
            kind
              ? `automation.schedule.${kind}`
              : "automation.schedule.unknown",
          )}
        </Badge>
        {plan.needsAttention && (
          <Badge variant="destructive" title={plan.attentionReasonCode}>
            {t("automation.needsAttention")}
          </Badge>
        )}
      </div>
      {plan.needsAttention && (
        <p className="text-[11px] text-destructive">
          {t("automation.needsAttentionNote")}
          {plan.attentionReasonCode ? ` · ${plan.attentionReasonCode}` : ""}
        </p>
      )}
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        <dt className="text-muted-foreground">{t("automation.nextDue")}</dt>
        <dd className="min-w-0 truncate">
          {instant(plan.nextDueUnixMs, locale, zone) ??
            t("automation.unknownTime")}
        </dd>
        <dt className="text-muted-foreground">{t("automation.target")}</dt>
        <dd className="min-w-0 truncate select-text">
          {plan.config?.target?.sessionId}
        </dd>
        {zone ? (
          <>
            <dt className="text-muted-foreground">
              {t("automation.timezone")}
            </dt>
            <dd className="min-w-0 truncate">{zone}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t("automation.revision")}</dt>
        <dd className="min-w-0 truncate tabular-nums">
          {String(snapshot.revision)} · v{String(plan.configVersion)}
        </dd>
      </dl>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          className="min-h-10"
          onClick={onViewRuns}
        >
          {t("automation.viewRuns")}
        </Button>
        {!hasCard && (
          <Button
            size="sm"
            variant="ghost"
            className="min-h-10"
            onClick={onShowOnCanvas}
          >
            {t("automation.showOnCanvas")}
          </Button>
        )}
        {/* 没有 manage 权限时这些按钮不渲染，而不是渲染成禁用的假按钮。 */}
        {canManage && plan.state !== ACTIVE && (
          <Button
            size="sm"
            className="min-h-10"
            disabled={busy}
            onClick={() => setConfirm("activate")}
          >
            {t("automation.activate")}
          </Button>
        )}
        {canManage && plan.state === ACTIVE && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="min-h-10"
              disabled={busy}
              onClick={onPause}
            >
              {t("automation.pause")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="min-h-10"
              disabled={busy}
              onClick={() => setConfirm("runNow")}
            >
              {t("automation.runNow")}
            </Button>
          </>
        )}
      </div>

      {hasCard && (
        <div className="flex flex-wrap gap-2 border-t border-border pt-2">
          <Button
            size="sm"
            variant="ghost"
            className="min-h-10"
            title={t("automation.detachNote")}
            onClick={onDetach}
          >
            {t("automation.detach")}
          </Button>
          {canManage && (
            <Button
              size="sm"
              variant="destructive"
              className="min-h-10"
              disabled={busy}
              title={t("automation.disableAndDetachNote")}
              onClick={onDisableAndDetach}
            >
              {t("automation.disableAndDetach")}
            </Button>
          )}
        </div>
      )}

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent className="z-[var(--z-dialog)]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                confirm === "runNow"
                  ? "automation.confirmRunNow"
                  : "automation.confirmActivate",
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                confirm === "runNow"
                  ? "automation.confirmRunNowNote"
                  : "automation.confirmActivateNote",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            <dt className="text-muted-foreground">
              {t("automation.configVersion")}
            </dt>
            <dd className="tabular-nums">{String(plan.configVersion)}</dd>
            <dt className="text-muted-foreground">
              {t("automation.revision")}
            </dt>
            <dd className="tabular-nums">{String(snapshot.revision)}</dd>
            <dt className="text-muted-foreground">
              {t("automation.configSha")}
            </dt>
            <dd className="min-w-0 break-all font-mono text-[11px] select-text">
              {digest}
            </dd>
          </dl>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-10">
              {t("automation.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-10"
              disabled={busy}
              onClick={() => {
                const action = confirm;
                setConfirm(null);
                if (action === "runNow") onRunNow();
                else if (action === "activate") onActivate();
              }}
            >
              {t(
                confirm === "runNow"
                  ? "automation.runNow"
                  : "automation.activate",
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
