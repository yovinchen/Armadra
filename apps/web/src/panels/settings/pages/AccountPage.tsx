import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { UsageProvider, UsageWindow } from "@ai-coding-canvas/shared";

import { runtimeApi } from "../../../api/client";
import { useT, type Translate } from "../../../app/preferences-store";
import { formatRelativeTime } from "../../../lib/format";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";

/**
 * 设置 → 账号与用量（§24.1）。
 *
 * 每个 provider 一张卡：凭据来源（只说**放在哪**，从不显示凭据本身）、
 * 各限流窗口的占用条与重置时间。刷新走 `POST /api/usage/refresh`，
 * Runtime 侧 30s 内只真取一次。
 */
export function AccountPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const usage = useQuery({
    queryKey: ["usage"],
    queryFn: runtimeApi.usage,
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: runtimeApi.refreshUsage,
    onSuccess: (next) => queryClient.setQueryData(["usage"], next),
  });
  const { settings, save } = useRuntimeSettings();
  // Runtime 侧默认开（settings.rs 归一化时补 `true`）。
  const usageEnabled = settings.data?.usage?.enabled !== false;

  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("settings.usageEnabled")}>
          <Switch
            checked={usageEnabled}
            disabled={!settings.data}
            aria-label={t("settings.usageEnabled")}
            onCheckedChange={(next) => {
              save.mutate({ usage: { enabled: next } });
              if (next)
                void queryClient.invalidateQueries({ queryKey: ["usage"] });
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      {(usage.data?.providers ?? []).map((provider) => (
        <SettingsGroup
          key={provider.id}
          title={t(`usage.provider.${provider.id}`)}
        >
          <SettingsRow label={t("settings.credentialSource")}>
            <span className="text-[13px] text-muted-foreground">
              {t(`settings.credential.${provider.credentialSource ?? "none"}`)}
            </span>
          </SettingsRow>

          {provider.status === "error" && (
            <SettingsRow label={t("usage.status.error")} />
          )}

          {provider.windows.map((window) => (
            <SettingsRow key={window.key} label={windowLabel(t, window)}>
              <UsageBar percent={window.usedPercent} />
              <span className="w-10 text-right text-[13px] tabular-nums text-muted-foreground">
                {t("usage.percent", { value: Math.round(window.usedPercent) })}
              </span>
              <span className="w-24 text-right text-[11px] text-muted-foreground">
                {window.resetsAt
                  ? t("usage.resetIn", {
                      value: formatRelativeTime(window.resetsAt),
                    })
                  : ""}
              </span>
            </SettingsRow>
          ))}
        </SettingsGroup>
      ))}

      <SettingsGroup>
        <SettingsRow label={null}>
          <Button
            variant="secondary"
            size="sm"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw />
            {t("usage.refresh")}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

/** `5h` / `7d` / `primary` 走 i18n；provider 自定义的标签原样显示。 */
function windowLabel(t: Translate, window: UsageWindow): string {
  const key = `usage.window.${window.label}`;
  const translated = t(key);
  return translated === key ? t(`usage.window.${window.key}`) : translated;
}

/** 阈值来自 §19：≥80% 警告色，≥95% 危险色。 */
function level(percent: number): "normal" | "warn" | "danger" {
  if (percent >= 95) return "danger";
  if (percent >= 80) return "warn";
  return "normal";
}

function UsageBar({ percent }: { percent: number }) {
  return (
    <span
      aria-hidden
      className="block h-1 w-24 shrink-0 overflow-hidden rounded-full bg-border-strong"
    >
      <span
        data-level={level(percent)}
        className="block h-full rounded-full bg-brand data-[level=danger]:bg-danger data-[level=warn]:bg-warn"
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </span>
  );
}

export type { UsageProvider };
