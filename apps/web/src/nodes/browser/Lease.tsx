import * as React from "react";
import type { BrowserActivity, BrowserLease } from "@armadra/shared";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { useT } from "@/app/preferences-store";

/**
 * 谁在控制这个浏览器（设计 §2.8）。
 *
 * 「你」和「其他设备」的区别来自设备自己发的那个不透明 id：Host 认证的是
 * 设备，但不会把身份转发给 Runtime，所以这个 id 只用来把持有者认出来，
 * 不授予任何权限。
 */
export function controllerKey(
  lease: BrowserLease | undefined,
  deviceId: string,
): { key: string; name: string } {
  if (!lease || lease.state === "free" || !lease.holder) {
    return { key: "browser.lease.free", name: "" };
  }
  if (lease.holder.kind === "agent") {
    return { key: "browser.lease.agent", name: lease.holder.displayName };
  }
  return {
    key:
      lease.holder.id === deviceId
        ? "browser.lease.you"
        : "browser.lease.otherDevice",
    name: lease.holder.displayName,
  };
}

/** 「2s」「3m」——一行动作后面那个相对时间，够用就好。 */
export function sinceLabel(at: string, now = Date.now()): string {
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return "";
  const seconds = Math.max(0, Math.round((now - parsed) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

export function LeaseBadge({
  lease,
  deviceId,
  busy,
  onTakeover,
  onHandback,
}: {
  lease: BrowserLease | undefined;
  deviceId: string;
  busy: boolean;
  onTakeover: () => void;
  onHandback: () => void;
}) {
  const t = useT();
  const controller = controllerKey(lease, deviceId);
  const mine =
    lease?.state === "humanTakeover" && lease.holder?.id === deviceId;
  return (
    <div className="flex items-center gap-1" data-no-drag="true">
      <Badge
        variant={lease?.state === "agent" ? "default" : "outline"}
        data-slot="browser-controller"
      >
        {t(controller.key, { name: controller.name })}
      </Badge>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-[22px] px-2 text-[11px]"
        disabled={busy}
        onClick={mine ? onHandback : onTakeover}
      >
        {t(mine ? "browser.lease.handback" : "browser.lease.takeover")}
      </Button>
    </div>
  );
}

/**
 * 租约徽标旁边那一行（复查 §7 的 #5 与 #8）。
 *
 * 两件事排在一行里：页面**现在**被什么挡着（对话框 / 文件选择器），以及
 * Agent **刚才**做了什么。挡住的那一件排在前面并且不用等宽字体——它是一句
 * 给人读的话，而动作流水是一串给人扫的记录。
 *
 * 这里不给任何按钮：对话框由主进程按 CDP 事件当场答复，人自己弹的那些走
 * Chromium 的原生模态。这一行的职责只有「让人知道页面停在哪」。
 */
export function ActivityStatus({
  activity,
  dialog,
  chooser,
}: {
  activity: BrowserActivity | null;
  dialog: { kind: string } | null;
  chooser: unknown | null;
}) {
  const t = useT();
  const prompt = dialog
    ? t(`browser.dialog.${dialog.kind}`)
    : chooser
      ? t("browser.chooser.title")
      : "";
  if (!prompt && !activity) return null;
  return (
    <span
      className="flex min-w-0 max-w-[220px] items-center gap-1.5"
      data-slot="browser-status"
      data-no-drag="true"
    >
      {prompt && (
        <span className="truncate text-[11px]" data-slot="browser-prompt">
          {prompt}
        </span>
      )}
      <ActivityLine activity={activity} />
    </span>
  );
}

/**
 * 最近一条动作。刷新时间只为了让「2s」不停在 2s——它不拉取任何东西。
 */
export function ActivityLine({
  activity,
}: {
  activity: BrowserActivity | null;
}) {
  const t = useT();
  const [, tick] = React.useReducer((value: number) => value + 1, 0);
  React.useEffect(() => {
    if (!activity) return;
    const timer = setInterval(tick, 5_000);
    return () => clearInterval(timer);
  }, [activity]);
  if (!activity) return null;
  const outcome =
    activity.outcome === "ok"
      ? ""
      : ` · ${t(`browser.activity.${activity.outcome}`)}`;
  return (
    <span
      className="truncate font-mono text-[11px] text-muted-foreground"
      data-slot="browser-activity"
      title={activity.reasonCode}
    >
      {activity.verb}
      {activity.target ? ` ${activity.target}` : ""} · {sinceLabel(activity.at)}
      {outcome}
    </span>
  );
}
