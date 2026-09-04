import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AgentInfo } from "@armadra/shared";

import { runtimeApi } from "../../../api/client";
import { useAgentsQuery } from "../../../app/use-agents";
import { useT } from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { ColorDot } from "@/ui/color-dot";
import { Switch } from "@/ui/switch";

/**
 * 设置 → Hook 与 Skills（§24.1）。
 *
 * 每个 CLI 一行：装没装、装的是哪一版客户端，右边是安装 / 重装 / 卸载。
 * 「未检测到 CLI」时全部禁用——没有 CLI 就没有配置文件可写。
 */
export function HooksPage() {
  const t = useT();
  const agents = useAgentsQuery();
  const { settings, save } = useRuntimeSettings();
  const replyApprovals = settings.data?.hooks?.replyApprovals === true;

  return (
    <>
      <SettingsGroup>
        {(agents.data ?? []).map((agent) => (
          <AgentHookRow key={agent.id} agent={agent} />
        ))}
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          label={t("settings.hooks.replyApprovals")}
          footnote={t("settings.hooks.replyApprovals.note")}
        >
          <Switch
            checked={replyApprovals}
            disabled={!settings.data}
            aria-label={t("settings.hooks.replyApprovals")}
            onCheckedChange={(next) =>
              save.mutate({ hooks: { replyApprovals: next } })
            }
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function AgentHookRow({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const queryClient = useQueryClient();

  const run = useMutation({
    mutationFn: (action: "install" | "uninstall") =>
      action === "install"
        ? runtimeApi.installAgentHooks(agent.id)
        : runtimeApi.uninstallAgentHooks(agent.id),
    onSuccess: (_report, action) => {
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success(
        t(
          action === "install"
            ? "settings.hooks.done"
            : "settings.hooks.removed",
        ),
      );
    },
    onError: (cause: Error) =>
      toast.error(t("settings.hooks.failed"), { description: cause.message }),
  });

  const supported = agent.capabilities.includes("hooks");
  const revision = agent.clientRevision;
  const hooked = typeof revision === "number";
  const busy = run.isPending;

  return (
    <SettingsRow
      label={
        <span className="flex items-center gap-2">
          <ColorDot color={agent.color} size={8} />
          {agent.label}
        </span>
      }
    >
      <Badge variant={hooked ? "secondary" : "outline"}>
        {!supported
          ? t("settings.hooks.pullOnly")
          : !agent.installed
            ? t("settings.agent.missing")
            : hooked
              ? t("settings.hooks.revision", { value: revision })
              : t("settings.hooks.missing")}
      </Badge>
      <Button
        variant="secondary"
        size="sm"
        disabled={!supported || !agent.installed || busy}
        onClick={() => run.mutate("install")}
      >
        {hooked ? t("settings.hooks.reinstall") : t("settings.hooks.install")}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={!supported || !agent.installed || !hooked || busy}
        onClick={() => run.mutate("uninstall")}
      >
        {t("settings.hooks.uninstall")}
      </Button>
    </SettingsRow>
  );
}
