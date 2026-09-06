import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AgentInfo } from "@armadra/shared";

import { runtimeApi } from "../../../api/client";
import { useAgentsQuery } from "../../../app/use-agents";
import { useT } from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";

/**
 * 一个适配器装的是什么（协作通道 §3.1、§2.2）。
 *
 * `hook` 是 CLI 按事件 fork 一次 `armadra-hook`；`extension` 是同一套 HTTP
 * 由 CLI 进程内的扩展直接发出。两者的认证完全相同——同一个 bearer、同一份
 * 节点令牌、同一个终端绑定——所以这里区分它们不是为了信任等级，而是因为
 * 「安装」这个动作落在不同的文件上：一个是配置文件里的 hooks 键，一个是
 * `~/.pi/agent/extensions/` 下的一份 TS。
 *
 * 与 Runtime 的 `agent.rs::state_source_for` 是同一张表。opencode 在 B3 挪进
 * `extension`：它的插件自己连 `hook.sock`，只在连不上时才回落去 spawn 客户端。
 */
const HOOK_CHANNELS: Record<string, "hook" | "extension"> = {
  claude: "hook",
  codex: "hook",
  gemini: "hook",
  opencode: "extension",
  copilot: "hook",
  pi: "extension",
  omp: "extension",
};

/** 自定义 Agent 跟着它的基础适配器走，和权限旗标、事件表一样。 */
function hookChannel(agent: AgentInfo): "hook" | "extension" {
  return HOOK_CHANNELS[agent.baseAgent ?? agent.id] ?? "hook";
}

/**
 * 设置 → 协作技能与状态 Hook（§24.1）。
 *
 * 两件互不依赖的事，所以是两张卡片：
 *
 *   * **协作技能**——写一份 `skills/armadra/SKILL.md`，告诉 CLI 这里有信箱、
 *     有连线上下文、有画布动词。没有它 CLI 照样能报状态。
 *   * **状态 Hook**——CLI 把会话事件报回来。没有它 Agent 照样能读信箱。
 *
 * 技能是按 CLI 的配置目录写的，自定义 Agent 与它的基础适配器共用同一份文件，
 * 所以技能那一组只列内置适配器，不给同一个文件开两行。
 *
 * 一行显示什么只看两件事：能力位（这个适配器存不存在）和本机检测（CLI 在
 * 不在）。安装能不能成不在这里猜——按钮照给，接口答什么就显示什么，
 * 包括「这个 CLI 还没有安装器」这种答复（协作通道 §5.1 B4）。
 */
export function HooksPage() {
  const t = useT();
  const agents = useAgentsQuery();
  const rows = agents.data ?? [];

  return (
    <>
      <SettingsGroup title={t("settings.skills")}>
        {rows
          .filter((agent) => !agent.baseAgent)
          .map((agent) => (
            <AgentSkillRow key={agent.id} agent={agent} />
          ))}
      </SettingsGroup>

      <SettingsGroup title={t("settings.hooks")}>
        {rows.map((agent) => (
          <AgentHookRow key={agent.id} agent={agent} />
        ))}
      </SettingsGroup>
    </>
  );
}

/** 协作技能一行。状态就是磁盘上那份文件的 revision，没有别的记录。 */
function AgentSkillRow({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const queryClient = useQueryClient();

  const run = useMutation({
    mutationFn: (action: "install" | "uninstall") =>
      action === "install"
        ? runtimeApi.installAgentSkills(agent.id)
        : runtimeApi.uninstallAgentSkills(agent.id),
    onSuccess: (report, action) => {
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success(
        t(
          action === "install"
            ? "settings.skills.done"
            : "settings.skills.removed",
        ),
        // 空 `paths` = 内容已经是最新的，一个字节都没写。
        report.paths.length > 0
          ? { description: report.paths.join("\n") }
          : { description: t("settings.skills.unchanged") },
      );
    },
    onError: (cause: Error) =>
      toast.error(t("settings.skills.failed"), { description: cause.message }),
  });

  const revision = agent.skillsRevision;
  const installed = typeof revision === "number";
  const busy = run.isPending;

  return (
    <SettingsRow label={agent.label}>
      <Badge variant={installed ? "secondary" : "outline"}>
        {!agent.installed
          ? t("settings.agent.missing")
          : installed
            ? t("settings.skills.revision", { value: revision })
            : t("settings.skills.missing")}
      </Badge>
      <Button
        variant="secondary"
        size="sm"
        disabled={!agent.installed || busy}
        onClick={() => run.mutate("install")}
      >
        {installed
          ? t("settings.skills.reinstall")
          : t("settings.skills.install")}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={!agent.installed || !installed || busy}
        onClick={() => run.mutate("uninstall")}
      >
        {t("settings.skills.uninstall")}
      </Button>
    </SettingsRow>
  );
}

/** 状态 Hook 一行：装没装、装的是哪一版客户端，右边是安装 / 重装 / 卸载。 */
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
        {supported && !agent.installed
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
