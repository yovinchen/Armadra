/**
 * 防休眠租约（T02，终端宿主设计 §9）。
 *
 * 界面上要说清楚三件事，因为它们经常被混为一谈：
 *
 *  1. **只挡系统空闲睡眠。** 不常亮屏幕，不管合盖，不拦用户自己点睡眠。
 *  2. **租约是申请，不是保证。** 策略不允许或平台没有机制时，租约照样列
 *     出来，只是 `active: false` 并写明原因——「跑一半怎么睡过去了」得能
 *     在这里查到。
 *  3. **策略在设置页改。** 这里只显示当前策略并给一个手动开关。
 */
import { useState } from "react";
import { toast } from "sonner";
import type { PowerState } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { formatRelativeTime } from "@/lib/format";
import { Badge } from "@/ui/badge";
import { Switch } from "@/ui/switch";

/** 手动租约的 TTL：面板开着时会跟着采样一起续，关掉后十分钟自然释放。 */
const MANUAL_TTL_SECONDS = 600;

export function PowerSection({
  power,
  onChanged,
}: {
  power: PowerState;
  onChanged: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const manual =
    power.leases.find((lease) => lease.source === "manual") ?? null;

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      if (next) {
        const lease = await runtimeApi.acquirePowerLease({
          source: "manual",
          reason: t("resources.power.manualReason"),
          ttlSeconds: MANUAL_TTL_SECONDS,
        });
        // 申请成功但没生效（策略是「从不」）要说出来，而不是让开关默默
        // 停在打开的样子。
        if (!lease.active && lease.blockedBy) {
          toast.warning(t(`resources.power.blocked.${lease.blockedBy}`));
        }
      } else if (manual) {
        await runtimeApi.releasePowerLease(manual.id);
      }
      onChanged();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : t("resources.power.failed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-[var(--r-card)] border border-border p-3">
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold">{t("resources.power")}</h3>
        <Badge
          variant={power.holding ? "default" : "ghost"}
          className="text-[11px]"
        >
          {power.holding
            ? t("resources.power.holding")
            : t("resources.power.idle")}
        </Badge>
        {power.mechanism && (
          <Badge variant="outline" className="font-mono text-[10px]">
            {power.mechanism}
          </Badge>
        )}
      </header>

      <div className="flex items-center gap-2 py-1">
        <Switch
          id="power-manual"
          checked={manual !== null}
          disabled={busy || !power.inhibitor.available}
          onCheckedChange={(next) => void toggle(next)}
        />
        <label htmlFor="power-manual" className="flex-1 text-[12px]">
          {t("resources.power.manual")}
        </label>
        <span className="text-[11px] text-muted-foreground">
          {t(`resources.power.policy.${power.policy}`)}
        </span>
      </div>

      {!power.inhibitor.available && (
        <p className="pt-1 text-[11px] text-muted-foreground">
          {power.inhibitor.detail ?? t("resources.power.unavailable")}
        </p>
      )}

      {/* 只挡空闲睡眠——这句必须一直在，不然界面等于在承诺它做不到的事。 */}
      <p className="pt-1 text-[11px] text-muted-foreground">
        {t("resources.power.scope")}
      </p>

      {power.leases.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5 border-t border-border pt-2">
          {power.leases.map((lease) => (
            <li key={lease.id} className="flex items-center gap-2 text-[12px]">
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full"
                style={{
                  background: lease.active
                    ? "var(--success)"
                    : "var(--muted-foreground)",
                }}
              />
              <span className="min-w-0 flex-1 truncate">{lease.reason}</span>
              <Badge variant="ghost" className="shrink-0 text-[10px]">
                {t(`resources.power.source.${lease.source}`)}
              </Badge>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {lease.blockedBy
                  ? t(`resources.power.blocked.${lease.blockedBy}`)
                  : t("resources.power.expires", {
                      value: formatRelativeTime(lease.expiresAt),
                    })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
