import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { runtimeApi } from "../../../api/client";
import { useT } from "../../../app/preferences-store";
import { openExternal } from "../../../platform";
import { SettingsGroup } from "../SettingsGroup";
import { LegacyArchives } from "../LegacyArchives";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { CONTROL_WIDTH } from "./GeneralPage";
import { Button } from "@/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";

/** `logs.retentionDays` 的四个取值；`0` = 永久（Runtime 只接受这几个）。 */
const RETENTION_CHOICES = [7, 30, 90, 0] as const;

/**
 * 设置 → 数据（§24.1）。
 *
 * 数据目录、数据库大小、对话索引与备份都来自 `GET /api/data/info`；
 * 重建索引与备份各自会把这份 info 置脏，所以数字改完就跟着变。
 */
export function DataPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const { settings, save } = useRuntimeSettings();

  const info = useQuery({
    queryKey: ["data-info"],
    queryFn: runtimeApi.dataInfo,
    retry: false,
  });

  const rebuild = useMutation({
    mutationFn: runtimeApi.refreshConversations,
    onSuccess: (report) => {
      void queryClient.invalidateQueries({ queryKey: ["data-info"] });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      toast.success(t("settings.rebuild.done", { value: report.total }));
    },
    onError: (cause: Error) =>
      toast.error(t("settings.saveFailed"), { description: cause.message }),
  });

  const backup = useMutation({
    mutationFn: runtimeApi.backupData,
    onSuccess: (result) =>
      toast.success(t("settings.backup.done", { path: result.path })),
    onError: (cause: Error) =>
      toast.error(t("settings.backup.failed"), { description: cause.message }),
  });

  const retention =
    settings.data?.logs?.retentionDays ??
    info.data?.boardLogRetentionDays ??
    30;

  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("settings.dataDir")}>
          <span className="max-w-[280px] truncate text-[11px] text-muted-foreground">
            {info.data?.dataDir ?? "—"}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={!info.data}
            onClick={() => {
              const dir = info.data?.dataDir;
              if (dir) void openExternal(`file://${encodeURI(dir)}`);
            }}
          >
            {t("settings.reveal")}
          </Button>
        </SettingsRow>

        <SettingsRow label={t("settings.dbSize")}>
          <span className="text-[13px] tabular-nums text-muted-foreground">
            {info.data ? formatBytes(info.data.dbBytes) : "—"}
          </span>
        </SettingsRow>

        <SettingsRow label={t("settings.conversationIndex")}>
          <span className="text-[13px] tabular-nums text-muted-foreground">
            {info.data
              ? t("settings.conversationCount", {
                  value: info.data.conversations,
                })
              : "—"}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={rebuild.isPending}
            onClick={() => rebuild.mutate()}
          >
            {t("settings.rebuild")}
          </Button>
        </SettingsRow>

        <SettingsRow label={t("settings.backup")}>
          <Button
            variant="secondary"
            size="sm"
            disabled={backup.isPending}
            onClick={() => backup.mutate()}
          >
            {t("settings.backup.run")}
          </Button>
        </SettingsRow>
      </SettingsGroup>
      <LegacyArchives />

      <SettingsGroup>
        <SettingsRow label={t("settings.logRetention")}>
          <Select
            value={String(retention)}
            disabled={!settings.data}
            onValueChange={(value) => {
              save.mutate(
                { logs: { retentionDays: Number(value) } },
                {
                  onSuccess: () =>
                    void queryClient.invalidateQueries({
                      queryKey: ["data-info"],
                    }),
                },
              );
            }}
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {RETENTION_CHOICES.map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {t(`settings.retention.${days}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

/** 1024 进制、最多一位小数；单位是符号，不进 i18n。 */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}
