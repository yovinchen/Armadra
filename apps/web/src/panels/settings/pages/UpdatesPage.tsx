import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { runtimeApi } from "../../../api/client";
import { usePreferencesStore, useT } from "../../../app/preferences-store";
import { useCanvasStore } from "../../../store/canvas-store";
import { useUpdatesSession } from "../../../host/updates-session";
import { openExternal } from "../../../platform";
import {
  formatProgress,
  mergeUpdatesState,
  type UpdatesAction,
} from "../../../updates/state";
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  useUpdateState,
} from "../../../updates/use-update-state";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Switch } from "@/ui/switch";

/** The channels a person may ask for; a local build is not one of them. */
const CHANNELS = ["stable", "beta"] as const;

/**
 * 设置 → 更新（S03 / docs/design/updates-and-service-install.md §4）。
 *
 * 这一页把两个来源合起来：后台服务判断「有没有可用发布」，桌面壳判断
 * 「能不能装」。合并规则全在 `updates/state.ts` 的纯函数里，这里只负责
 * 把它渲染成行——包括那条最重要的：任何一边没回答，都不写「已是最新」。
 */
export function UpdatesPage() {
  const t = useT();
  const setPanel = useCanvasStore((state) => state.setPanel);
  const connect = useUpdatesSession((store) => store.connect);
  const sessionState = useUpdatesSession((store) => store.state);
  const { settings, save } = useRuntimeSettings();

  const host = useUpdateState((store) => store.host);
  const shell = useUpdateState((store) => store.shell);
  const restart = useUpdateState((store) => store.restart);
  const start = useUpdateState((store) => store.start);
  const check = useUpdateState((store) => store.check);
  const download = useUpdateState((store) => store.download);
  const install = useUpdateState((store) => store.install);
  const dismiss = useUpdateState((store) => store.dismiss);
  const acknowledgeRestart = useUpdateState(
    (store) => store.acknowledgeRestart,
  );

  const health = useQuery({
    queryKey: ["health"],
    queryFn: runtimeApi.health,
    retry: false,
  });
  const installed = health.data?.version ?? "";

  const preferences = settings.data?.updates;
  const channel = preferences?.channel ?? "stable";
  const autoCheck = preferences?.autoCheck ?? true;
  const autoDownload = preferences?.autoDownload ?? false;

  React.useEffect(() => {
    void connect();
    return start();
  }, [connect, start]);

  const runCheck = React.useCallback(() => {
    if (!installed) return;
    void check({ channel, installedVersion: installed });
  }, [check, channel, installed]);

  // Design §2.1: 30 seconds after start, then every six hours. A person who is
  // never told a release exists cannot decide to install it — but the switch
  // is theirs, and off means off.
  React.useEffect(() => {
    if (!autoCheck || !installed || sessionState.status !== "ready") return;
    const first = setTimeout(runCheck, FIRST_CHECK_DELAY_MS);
    const repeat = setInterval(runCheck, CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(repeat);
    };
  }, [autoCheck, installed, runCheck, sessionState.status]);

  const view = mergeUpdatesState(host, shell);

  // `autoDownload` fetches without being asked; installing still never happens
  // without a person (design §2.4, S03 acceptance).
  React.useEffect(() => {
    if (autoDownload && view.state === "available") void download();
  }, [autoDownload, download, view.state]);

  const busy = view.state === "checking";
  const notesUrl = view.offer?.notesUrl || view.release?.notesUrl || "";

  function perform(action: UpdatesAction) {
    switch (action) {
      case "check":
        return runCheck();
      case "download":
        return void download();
      case "skip":
        return void dismiss();
      case "restart":
        return void install();
      case "retry":
        return void download();
      case "notes":
        return void (notesUrl && openExternal(notesUrl));
      case "openHostSettings":
        usePreferencesStore.getState().setLastSettingsSection("host");
        return setPanel("settings", true);
    }
  }

  return (
    <>
      <p className="text-[13px] leading-5 text-muted-foreground">
        {t("updates.note")}
      </p>

      {restart && (
        <SettingsGroup title={t("updates.nav")}>
          <SettingsRow
            label={
              restart.outcome === "completed"
                ? t("updates.restart.completed", { value: restart.version })
                : t("updates.restart.incomplete", {
                    value: restart.mismatched
                      .map((part) => t(`updates.component.${part}`))
                      .join(t("updates.listSeparator")),
                  })
            }
          >
            <Button size="sm" variant="secondary" onClick={acknowledgeRestart}>
              {t("updates.restart.dismiss")}
            </Button>
          </SettingsRow>
          {restart.outcome === "incomplete" && restart.previousPackageUrl && (
            <SettingsRow label={t("updates.restart.previous")}>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void openExternal(restart.previousPackageUrl)}
              >
                {restart.previousVersion}
              </Button>
            </SettingsRow>
          )}
        </SettingsGroup>
      )}

      <SettingsGroup>
        <SettingsRow label={t("updates.version")}>
          <span className="text-[13px] tabular-nums text-muted-foreground">
            {installed || t("updates.version.unknown")}
          </span>
        </SettingsRow>

        <SettingsRow label={t("updates.channel")}>
          <Select
            value={channel}
            onValueChange={(value) =>
              save.mutate({
                updates: { channel: value as (typeof CHANNELS)[number] },
              })
            }
          >
            <SelectTrigger size="sm" className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {CHANNELS.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {t(`updates.channel.${entry}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow label={t("updates.autoCheck")}>
          <Switch
            checked={autoCheck}
            aria-label={t("updates.autoCheck")}
            onCheckedChange={(next) =>
              save.mutate({ updates: { autoCheck: next } })
            }
          />
        </SettingsRow>

        <SettingsRow
          label={t("updates.autoDownload")}
          footnote={t("updates.autoDownload.note")}
        >
          <Switch
            checked={autoDownload}
            aria-label={t("updates.autoDownload")}
            onCheckedChange={(next) =>
              save.mutate({ updates: { autoDownload: next } })
            }
          />
        </SettingsRow>

        <SettingsRow label={t("updates.status")}>
          <span
            role="status"
            aria-live="polite"
            className="text-right text-[13px] text-muted-foreground"
          >
            {t(view.statusKey)}
          </span>
        </SettingsRow>

        {view.progress && (
          <SettingsRow label={t("updates.progress")}>
            <span className="text-[13px] tabular-nums text-muted-foreground">
              {formatProgress(
                view.progress.receivedBytes,
                view.progress.totalBytes,
              )}
            </span>
          </SettingsRow>
        )}

        {view.actions.length > 0 && (
          <SettingsRow label={null}>
            <div className="flex flex-wrap gap-2">
              {view.actions.map((action, index) => (
                <Button
                  key={action}
                  size="sm"
                  className="min-h-10"
                  variant={index === 0 ? "default" : "secondary"}
                  disabled={
                    busy ||
                    (action === "check" && !installed) ||
                    (action === "notes" && !notesUrl)
                  }
                  onClick={() => perform(action)}
                >
                  {t(
                    action === "check"
                      ? busy
                        ? "updates.checking"
                        : "updates.check"
                      : action === "openHostSettings"
                        ? "updates.blocked.action"
                        : `updates.action.${action}`,
                  )}
                </Button>
              ))}
            </div>
          </SettingsRow>
        )}
      </SettingsGroup>

      {view.detailKeys.map((key) => (
        <p key={key} className="text-[13px] leading-5 text-muted-foreground">
          {t(key)}
        </p>
      ))}

      {view.partial && (
        <p className="text-[13px] leading-5 text-muted-foreground">
          {t(`updates.partial.${view.partial}`)}
        </p>
      )}

      {view.retryAfterMs > 0 && (
        <p className="text-[13px] leading-5 text-muted-foreground">
          {t("updates.retryAfter", {
            value: Math.ceil(view.retryAfterMs / 60_000),
          })}
        </p>
      )}

      {view.release && (
        <SettingsGroup title={t("updates.release")}>
          <SettingsRow label={view.release.version}>
            <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
              {t(`updates.channel.${view.release.channel}`)}
            </Badge>
          </SettingsRow>
          {view.release.signature !== "unknown" && (
            <SettingsRow
              label={t("updates.signature")}
              footnote={t(`updates.signature.${view.release.signature}`)}
            />
          )}
        </SettingsGroup>
      )}
    </>
  );
}
