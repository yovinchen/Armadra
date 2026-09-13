import { useQueryClient } from "@tanstack/react-query";
import { useUsage } from "../../../app/use-usage";
import { ProviderDetail } from "../../../shell/ProviderDetail";
import { RefreshCw } from "lucide-react";
import type { UsageProvider, UsageProviderId } from "@armadra/shared";

import { useT } from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { CopilotSignIn } from "./CopilotSignIn";
import { CONTROL_WIDTH } from "./GeneralPage";
import { ModelCatalogPanel } from "./ModelCatalogPanel";
import { Button } from "@/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Switch } from "@/ui/switch";

/** 逐个 provider 的开关顺序，和画布里的卡片顺序一致。 */
const PROVIDERS: UsageProviderId[] = ["claude", "codex", "gemini", "copilot"];

/**
 * 刷新节奏（§4.2）。`0` = 只手动刷新；其余是后台自动刷新的分钟数。
 * Runtime 的 `normalize` 只接受这几个值，改动要两边一起改。
 */
const REFRESH_CHOICES = [0, 1, 2, 5, 15] as const;

/**
 * 设置 → 账号与用量（§24.1 + §4.2）。
 *
 * 每个 provider 一张卡：凭据来源（只说**放在哪**，从不显示凭据本身）、
 * 各限流窗口的占用条与重置时间。刷新走 `POST /api/usage/refresh`，
 * Runtime 侧 30s 内只真取一次。
 *
 * §4.2 补上四组控制：总开关、逐个 provider 开关、刷新节奏、以及本地成本
 * 统计开关；Copilot 的登录 / 登出单独一张卡。
 */
export function AccountPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const { usage, refresh, refreshing, refreshFailed, now, cooldown } =
    useUsage();
  const { settings, save } = useRuntimeSettings();
  // Runtime 侧默认开（settings.rs 归一化时补 `true`）。
  const usageEnabled = settings.data?.usage?.enabled !== false;
  const costEnabled = settings.data?.usage?.cost?.enabled !== false;
  const cliFallback = settings.data?.usage?.codexCliFallback === true;
  const refreshMinutes = settings.data?.usage?.refreshMinutes ?? 5;
  const providerOn = (id: string) =>
    settings.data?.usage?.providers?.[id] !== false;
  const busy = !settings.data || save.isPending;

  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("settings.usageEnabled")}>
          <Switch
            checked={usageEnabled}
            disabled={busy}
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

        <SettingsRow
          label={t("settings.usageCadence")}
          footnote={t("settings.usageCadenceHint")}
        >
          <Select
            value={String(refreshMinutes)}
            disabled={busy || !usageEnabled}
            onValueChange={(value) =>
              save.mutate({ usage: { refreshMinutes: Number(value) } })
            }
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {REFRESH_CHOICES.map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {minutes === 0
                    ? t("settings.cadence.manual")
                    : t("settings.cadence.minutes", { count: minutes })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        {PROVIDERS.map((id) => (
          <SettingsRow key={id} label={t(`usage.provider.${id}`)}>
            <Switch
              checked={providerOn(id)}
              disabled={busy || !usageEnabled}
              aria-label={t(`usage.provider.${id}`)}
              onCheckedChange={(next) =>
                save.mutate(
                  { usage: { providers: { [id]: next } } },
                  { onSuccess: () => refresh.mutate() },
                )
              }
            />
          </SettingsRow>
        ))}
        <SettingsRow
          label={t("settings.codexCliFallback")}
          footnote={t("settings.codexCliFallbackHint")}
        >
          <Switch
            checked={cliFallback}
            disabled={busy || !usageEnabled}
            aria-label={t("settings.codexCliFallback")}
            onCheckedChange={(next) =>
              save.mutate({ usage: { codexCliFallback: next } })
            }
          />
        </SettingsRow>
      </SettingsGroup>

      <CopilotSignIn disabled={busy} />

      <SettingsGroup>
        <SettingsRow
          label={t("settings.costEnabled")}
          footnote={t("settings.costEnabledHint")}
        >
          <Switch
            checked={costEnabled}
            disabled={busy}
            aria-label={t("settings.costEnabled")}
            onCheckedChange={(next) =>
              save.mutate(
                { usage: { cost: { enabled: next } } },
                {
                  onSuccess: () =>
                    void queryClient.invalidateQueries({
                      queryKey: ["usage-cost"],
                    }),
                },
              )
            }
          />
        </SettingsRow>
      </SettingsGroup>

      <ModelCatalogPanel />

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
