import { useMutation } from "@tanstack/react-query";
import { Wrench } from "lucide-react";
import { toast } from "sonner";
import type { AgentInfo } from "@armadra/shared";

import { runtimeApi } from "../../../api/client";
import { useAgentsQuery } from "../../../app/use-agents";
import { useT, type Translate } from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import type { IntegrationRepairReport } from "./integration/types";
import {
  runIntegrationInstall,
  useAgentIntegration,
  useIntegrationRefresh,
} from "./integration/use-integration";

/**
 * 设置 → 集成（[Agent 接入归一](../../../../../docs/design/agent-integration-mcp.md) §2「一处管理」）。
 *
 * 取代「Hook 与 Skills」那两张卡片。用户实测的结论是「能否归一成一种、统一
 * 管理」：以前一个 CLI 要装两样东西、管三处状态，页面也照着分了两组，于是
 * 同一个 CLI 在一页里出现两次，而「为什么装不上」的答案（配置里还留着旧产品
 * 名时期的条目）一个字都没有。
 *
 * 现在每种 CLI 就是**一行**，一行回答四件事：
 *
 *  1. **注入方式**——启动时 / 配置文件 / 扩展。它决定了「装」这个动作到底
 *     碰不碰用户的全局配置，所以必须说出来，而不是藏在文档里。
 *  2. **Hook 状态**——CLI 把会话事件报回来的那一半。
 *  3. **技能状态**——教 CLI 画布动词的那一份 `SKILL.md`。
 *  4. **旧残留**——`aicc-hook`、`aicc-canvas` 与上一个产品名（`LEGACY_MARKERS`）
 *     留下的条目，逐条列出来，旁边一个「修复」。
 *
 * Hook 与技能是**一个**安装单元：一个「安装 / 卸载」按钮同时管它们。分成两个
 * 按钮就是让用户去记「先装哪个」，而只装其中一个的状态没有任何用处。
 *
 * 一行显示什么只看两件事：能力位（这个适配器存不存在）和本机检测（CLI 在
 * 不在）。安装能不能成不在这里猜——按钮照给，接口答什么就显示什么，
 * 包括「这个 CLI 还没有安装器」这种答复（协作通道 §5.1 B4）。
 */
export function IntegrationPage() {
  const t = useT();
  const agents = useAgentsQuery();
  const list = agents.data ?? [];

  return (
    <SettingsGroup>
      {list.map((agent) => (
        <AgentIntegrationRow key={agent.id} agent={agent} />
      ))}
      {/* 一行都没有时整页是空白的——没有 CLI 与还没读完看起来一模一样。 */}
      {list.length === 0 && (
        <SettingsRow
          label={t(
            agents.isPending ? "integration.loading" : "integration.empty",
          )}
        />
      )}
    </SettingsGroup>
  );
}

/** 「修复」之后把 found / removed / kept / backup 四段原样报给用户。 */
function repairDescription(
  t: Translate,
  report: IntegrationRepairReport,
): string {
  const lines = [
    t("integration.repair.found", { count: report.found.length }),
    t("integration.repair.removed", { count: report.removed.length }),
    t("integration.repair.kept", { count: report.kept.length }),
  ];
  if (report.backup)
    lines.push(t("integration.backup", { path: report.backup }));
  return lines.join("\n");
}

function AgentIntegrationRow({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const refresh = useIntegrationRefresh();
  const { integration } = useAgentIntegration(agent);

  const install = useMutation({
    mutationFn: (action: "install" | "uninstall") =>
      runIntegrationInstall(agent.id, action),
    onSuccess: (warning, action) => {
      refresh(agent.id);
      toast.success(
        t(action === "install" ? "integration.done" : "integration.removed"),
        // 装成了但动过用户自己的东西时必须说一句：Claude 的 statusLine 是
        // 用户写的，我们只是没把它覆盖掉，这值得一行字。
        warning === "context_statusline_preserved"
          ? { description: t("context.statusLinePreserved") }
          : undefined,
      );
    },
    onError: (cause: Error) =>
      toast.error(t("integration.failed"), { description: cause.message }),
  });

  const repair = useMutation({
    mutationFn: () => runtimeApi.repairAgentIntegration(agent.id),
    onSuccess: (report) => {
      refresh(agent.id);
      toast.success(t("integration.repair.done"), {
        description: repairDescription(t, report),
      });
    },
    onError: (cause: Error) =>
      toast.error(t("integration.repair.failed"), {
        description: cause.message,
      }),
  });

  // 能力位说的是「这个适配器有没有 Hook 通道」；没有的话装什么都没有对象。
  const hooked = agent.capabilities.includes("hooks");
  const busy = install.isPending || repair.isPending;
  // 第一次读还没回来：只画标签与一个「读取中」徽标，不猜任何状态。
  if (!integration) {
    return (
      <SettingsRow label={agent.label}>
        <Badge variant="outline">{t("integration.loading")}</Badge>
      </SettingsRow>
    );
  }
  const installed = integration.hook.installed;
  // 每条残留是磁盘上的一处：配置里的一个条目或一个目录，连同它的样子。
  const legacy = integration.legacy.found.map(
    (finding) => `${finding.path} (${finding.detail})`,
  );

  return (
    <SettingsRow
      label={agent.label}
      {...(legacy.length > 0
        ? {
            footnote: t("integration.legacy.list", {
              items: legacy.join(" · "),
            }),
          }
        : {})}
    >
      <Badge variant="outline">
        {t(`integration.mode.${integration.mode}`)}
      </Badge>

      {/* Hook 与技能各一个状态徽标：它们一起装，但可以各自掉，而「掉了哪
          一半」正是用户要知道的事。 */}
      <Badge
        variant={installed ? "secondary" : "outline"}
        title={integration.hook.path ?? undefined}
      >
        {hooked && !agent.installed
          ? t("integration.agentMissing")
          : installed
            ? t("integration.hook.revision", {
                value: integration.hook.revision ?? integration.revision,
              })
            : t("integration.hook.missing")}
      </Badge>
      <Badge
        variant={integration.skill.installed ? "secondary" : "outline"}
        title={integration.skill.path ?? undefined}
      >
        {integration.skill.installed
          ? t("integration.skill.revision", {
              value: integration.skill.revision ?? integration.revision,
            })
          : t("integration.skill.missing")}
      </Badge>

      {legacy.length > 0 && (
        <Badge variant="destructive">
          {t("integration.legacy.count", { count: legacy.length })}
        </Badge>
      )}

      {/* 扩展型的 CLI 没有「文件」可装：它的扩展随 CLI 自己的安装走，
          这里给一个禁用的按钮只会让人以为是坏了，所以干脆不给。 */}
      {integration.mode !== "extension" && (
        <Button
          variant="secondary"
          size="sm"
          disabled={!hooked || !agent.installed || busy}
          onClick={() => install.mutate("install")}
        >
          {installed ? t("integration.reinstall") : t("integration.install")}
        </Button>
      )}
      {integration.mode !== "extension" && (
        <Button
          variant="secondary"
          size="sm"
          disabled={!hooked || !agent.installed || !installed || busy}
          onClick={() => install.mutate("uninstall")}
        >
          {t("integration.uninstall")}
        </Button>
      )}

      {legacy.length > 0 && (
        <Button
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={() => repair.mutate()}
        >
          <Wrench />
          {t("integration.repair")}
        </Button>
      )}
    </SettingsRow>
  );
}
