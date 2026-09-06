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
import { Switch } from "@/ui/switch";

/**
 * 一个适配器装的是什么（协作通道 §3.1、§2.2）。
 *
 * `hook` 是 CLI 按事件 fork 一次 `armadra-hook`；`extension` 是同一套 HTTP
 * 由 CLI 进程内的扩展直接发出。两者的认证完全相同——同一个 bearer、同一份
 * 节点令牌、同一个终端绑定——所以这里区分它们不是为了信任等级，而是因为
 * 「安装」这个动作落在不同的文件上：一个是配置文件里的 hooks 键，一个是
 * `~/.pi/agent/extensions/` 下的一份 TS。
 *
 * 与 Runtime 的 `agent.rs::state_source_for` 是同一张表。B3 之后 opencode
 * 也会挪到 `extension` 这一列。
 */
const HOOK_CHANNELS: Record<string, "hook" | "extension"> = {
  claude: "hook",
  codex: "hook",
  gemini: "hook",
  opencode: "hook",
  copilot: "hook",
  pi: "extension",
  omp: "extension",
};

/** 自定义 Agent 跟着它的基础适配器走，和权限旗标、事件表一样。 */
function hookChannel(agent: AgentInfo): "hook" | "extension" {
  return HOOK_CHANNELS[agent.baseAgent ?? agent.id] ?? "hook";
}

/**
 * 设置 → Hook 与 Skills（§24.1）。
 *
 * 每个 CLI 一行：装没装、装的是哪一版客户端，右边是安装 / 重装 / 卸载。
 * 「未检测到 CLI」时全部禁用——没有 CLI 就没有配置文件可写。
 *
 * 一行显示什么只看两件事：能力位（这个适配器存不存在）和本机检测（CLI 在
 * 不在）。安装能不能成不在这里猜——按钮照给，接口答什么就显示什么，
 * 包括「这个 CLI 还没有安装器」这种答复（协作通道 §5.1 B4）。
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
    onSuccess: (report, action) => {
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success(
        t(
          action === "install"
            ? "settings.hooks.done"
            : "settings.hooks.removed",
        ),
        report.warning === "context_statusline_preserved"
          ? { description: t("context.statusLinePreserved") }
          : undefined,
      );
    },
    onError: (cause: Error) =>
      toast.error(t("settings.hooks.failed"), { description: cause.message }),
  });

  const supported = agent.capabilities.includes("hooks");
  const revision = agent.clientRevision;
  const hooked = typeof revision === "number";
  const busy = run.isPending;
  // 只在装的东西不是 hooks 时说一句：默认那一列说了等于没说。
  const extension = supported && hookChannel(agent) === "extension";

  return (
    <SettingsRow
      label={<span className="flex items-center gap-2">{agent.label}</span>}
    >
      {extension && (
        <Badge variant="outline">{t("settings.hooks.extension")}</Badge>
      )}
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
