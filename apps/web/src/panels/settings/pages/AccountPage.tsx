import { useQueryClient } from "@tanstack/react-query";
import { useUsage } from "../../../app/use-usage";
import { ProviderDetail } from "../../../shell/ProviderDetail";
import { RefreshCw } from "lucide-react";
import type { UsageProvider } from "@armadra/shared";

import { useT } from "../../../app/preferences-store";
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
  const { usage, refresh, refreshing, refreshFailed, now, cooldown } =
    useUsage();
  const { settings, save } = useRuntimeSettings();
  // Runtime 侧默认开（settings.rs 归一化时补 `true`）。
  const usageEnabled = settings.data?.usage?.enabled !== false;

  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("settings.usageEnabled")}>
          <Switch
            checked={usageEnabled}
            disabled={!settings.data || save.isPending}
            aria-label={t("settings.usageEnabled")}
            onCheckedChange={(next) => {
              save.mutate(
                { usage: { enabled: next } },
                {
                  onSuccess: () => {
                    if (next) refresh.mutate();
                    else
                      void queryClient.invalidateQueries({
                        queryKey: ["usage"],
                      });
                  },
                },
              );
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      {!usageEnabled && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("usage.paused")}
        </p>
      )}
      {usageEnabled &&
        (usage.data?.providers ?? []).map((provider) => (
          <SettingsGroup key={provider.id}>
            <div className="p-4">
              <ProviderDetail
                provider={
                  usage.isError ? { ...provider, status: "error" } : provider
                }
                now={now}
                showCredentialSource
              />
            </div>
          </SettingsGroup>
        ))}

      <SettingsGroup>
        <SettingsRow label="OpenCode">
          <span className="text-right text-xs text-muted-foreground">
            {t("usage.source.opencode")}
          </span>
        </SettingsRow>
        <SettingsRow label="Copilot">
          <span className="text-right text-xs text-muted-foreground">
            {t("usage.source.copilot")}
          </span>
        </SettingsRow>
        <SettingsRow label="Pi / OMP">
          <span className="text-right text-xs text-muted-foreground">
            {t("usage.source.provider")}
          </span>
        </SettingsRow>
      </SettingsGroup>

      {usageEnabled && (refreshFailed || usage.isError) && (
        <p role="status" className="text-xs text-danger">
          {t("usage.refreshError")}
        </p>
      )}
      <SettingsGroup>
        <SettingsRow label={null}>
          <Button
            variant="secondary"
            size="sm"
            disabled={refreshing || cooldown > 0 || !usageEnabled}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
            {cooldown > 0
              ? t("usage.cooldown", { seconds: cooldown })
              : t("usage.refresh")}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

export type { UsageProvider };
