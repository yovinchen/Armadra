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
