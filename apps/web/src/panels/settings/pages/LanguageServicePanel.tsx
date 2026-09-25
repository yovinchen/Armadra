import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";

import { isUnsupportedOnRemote, runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { refreshFormatOnSave } from "@/editor/language/settings";
import { useLanguageStatusStore } from "@/editor/language/status-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Switch } from "@/ui/switch";
import { LocalSourceBadge } from "../local-source";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";

/**
 * 设置 → 工作区里的语言服务表（语言服务设计 §4.2、§6.1）。
 *
 * 每种语言一行：状态徽标、版本、可执行路径、开关、重启 / 停止。**每种语言
 * 都有一行**，哪怕这台机器上一个 server 都没有——不可用是一个答案，带
 * 原因；空面板什么也没说。
 *
 * 这里没有「安装」按钮，将来也不会有：Armadra 只用用户已经装好的 server
 * （设计 §6.2）。路径框是给已经装了但不在 PATH 上的那些用的。
 */
export function LanguageServicePanel({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const { settings, save } = useRuntimeSettings();
  const setServers = useLanguageStatusStore((state) => state.setServers);
  const stderr = useLanguageStatusStore((state) => state.stderr);

  const probe = useQuery({
    queryKey: ["language-service", workspaceId],
    queryFn: () => runtimeApi.languageService(workspaceId),
    enabled: Boolean(workspaceId),
    retry: false,
  });

  // 探测结果进 store，状态栏与问题面板不必各拉一次。
  React.useEffect(() => {
    if (probe.data) setServers(workspaceId, probe.data.servers);
  }, [probe.data, workspaceId, setServers]);

  const overrides = settings.data?.language?.servers ?? {};
  const formatOnSave = settings.data?.language?.formatOnSave === true;

  const [busy, setBusy] = React.useState<string | null>(null);
  const control = async (serverId: string, action: "restart" | "stop") => {
    setBusy(serverId);
    try {
      await (action === "restart"
        ? runtimeApi.restartLanguageServer(workspaceId, serverId)
        : runtimeApi.stopLanguageServer(workspaceId, serverId));
      await probe.refetch();
    } catch (error) {
      // 「这台机器上跑不了」不会出现在下一次探测的 reason 里——探测问的是
      // 远端有没有这个 server，而这两个动作根本没到远端。所以只有这一种失败
      // 需要说出来，其余照旧由 reason 解释。
      if (isUnsupportedOnRemote(error)) toast.error(t("settings.remoteOnly"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsGroup title={t("lsp.title")}>
      <SettingsRow
        label={t("lsp.formatOnSave")}
        footnote={t("lsp.description")}
      >
        <Switch
          checked={formatOnSave}
          disabled={!settings.data}
          aria-label={t("lsp.formatOnSave")}
          onCheckedChange={(next) => {
            // 保存路径同步读一份缓存（`editor/language/settings.ts`），
            // 写完立刻刷新，下一次保存就是新值。
            save.mutate(
              { language: { formatOnSave: next } },
              { onSuccess: () => void refreshFormatOnSave() },
            );
          }}
        />
      </SettingsRow>

      {/* 每台机器的 language server 装在不同地方，探测结果也是这台机器的，
          所以路径覆盖与探测缓存都留在本机。 */}
      <SettingsRow label={null}>
        <LocalSourceBadge path="language.servers" />
        <Button
          size="sm"
          variant="secondary"
          disabled={probe.isFetching}
          onClick={() => {
            void runtimeApi
              .languageService(workspaceId, true)
              .then(() => probe.refetch());
          }}
        >
          <RotateCw />
          {t("lsp.reprobe")}
        </Button>
      </SettingsRow>

      {probe.isPending && <SettingsRow label={t("lsp.probing")} />}
      {!probe.isPending && (probe.data?.servers.length ?? 0) === 0 && (
        <SettingsRow label={t("lsp.noServers")} />
      )}

      {(probe.data?.servers ?? []).map((server) => {
        const override = overrides[server.serverId] ?? {};
        const enabled = override.enabled !== false;
        const tail = stderr[`${workspaceId} ${server.serverId}`];
        return (
          <div
            key={`${server.languageId} ${server.serverId}`}
            className="flex flex-col gap-2 px-4 py-3"
            data-testid={`lsp-row-${server.serverId}`}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px]">
                {server.languageId} · {server.serverId}
              </span>
              <Badge
                variant={server.state === "running" ? "default" : "outline"}
              >
                {t(`lsp.state.${server.state}`)}
              </Badge>
              {server.version && (
                <span className="text-[11px] text-muted-foreground">
                  {server.version}
                </span>
              )}
              <Switch
                checked={enabled}
                disabled={!settings.data}
                aria-label={`${server.serverId} · ${t("lsp.enabled")}`}
                onCheckedChange={(next) =>
                  save.mutate({
                    language: {
                      servers: { [server.serverId]: { enabled: next } },
                    },
                  })
                }
              />
              <IconButton
                label={`${server.serverId} · ${t("lsp.restart")}`}
                disabled={busy === server.serverId}
                onClick={() => void control(server.serverId, "restart")}
              >
                <RotateCw />
              </IconButton>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === server.serverId}
                onClick={() => void control(server.serverId, "stop")}
              >
                {t("lsp.stop")}
              </Button>
            </div>

            {server.reason && (
              <p className="text-[11px] text-muted-foreground">
                {t(`lsp.reason.${server.reason}`)}
              </p>
            )}

            <Input
              defaultValue={override.path ?? ""}
              placeholder={server.executable || t("lsp.pathPlaceholder")}
              aria-label={`${server.serverId} · ${t("lsp.pathOverride")}`}
              className="h-8 text-[12px]"
              onBlur={(event) => {
                const next = event.target.value.trim();
                if (next === (override.path ?? "")) return;
                save.mutate({
                  language: {
                    servers: {
                      // 空串表示「不覆盖」；Runtime 的 merge 用 `null` 删键。
                      [server.serverId]: { path: next === "" ? null : next },
                    },
                  },
                });
              }}
            />

            {tail && (
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-sm)] bg-[var(--surface-sunken)] p-2 text-[11px] text-muted-foreground">
                {tail}
              </pre>
            )}
          </div>
        );
      })}
    </SettingsGroup>
  );
}
