import { useQuery } from "@tanstack/react-query";

import { WorkspaceExecution } from "./WorkspaceExecution";
import { runtimeApi } from "../../../api/client";
import { useAgentsQuery } from "../../../app/use-agents";
import { useT } from "../../../app/preferences-store";
import { useCanvasStore } from "../../../store/canvas-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { CONTROL_WIDTH } from "./GeneralPage";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Badge } from "@/ui/badge";
import { Switch } from "@/ui/switch";

/** 「跟随全局」在 Select 里需要一个值——空串会被 Radix 当成未选中。 */
const INHERIT = "__inherit__";

/**
 * 设置 → 工作区（§24.1）：**当前**这块工作空间的开关。
 *
 * Agent 互发消息与默认 Agent 覆盖都存在 Runtime 的 `workspaces.<id>` 段里。
 */
export function WorkspacePage() {
  const t = useT();
  const agents = useAgentsQuery();
  const { settings, save } = useRuntimeSettings();

  const workspace = useCanvasStore((state) => state.workspace);
  const workspaceId = workspace?.id ?? null;

  // 语言服务能力探测（E01/M4）。Runtime 目前只会回 `unavailable`；探测失败
  // 也当作未启用——两种情况对用户是同一句话，没有 LSP 可用。
  const languageService = useQuery({
    queryKey: ["language-service", workspaceId],
    queryFn: () => runtimeApi.languageService(workspaceId!),
    enabled: Boolean(workspaceId),
    retry: false,
  });

  const section = workspaceId
    ? settings.data?.workspaces?.[workspaceId]
    : undefined;
  const agentMessaging = section?.agentMessaging === true;
  const defaultAgent = section?.defaultAgent ?? INHERIT;

  if (!workspaceId) {
    return (
      <SettingsGroup>
        <SettingsRow label={t("settings.noWorkspace")} />
      </SettingsGroup>
    );
  }

  return (
    <>
      <WorkspaceExecution />
      <SettingsGroup>
        <SettingsRow label={t("settings.agentMessaging")}>
          <Switch
            checked={agentMessaging}
            disabled={!settings.data}
            aria-label={t("settings.agentMessaging")}
            onCheckedChange={(next) =>
              save.mutate({
                workspaces: { [workspaceId]: { agentMessaging: next } },
              })
            }
          />
        </SettingsRow>

        <SettingsRow label={t("settings.workspaceDefaultAgent")}>
          <Select
            value={defaultAgent}
            disabled={!settings.data}
            onValueChange={(value) =>
              save.mutate({
                workspaces: {
                  // `null` 让 Runtime 的 merge 删掉这个键，回到全局默认。
                  [workspaceId]: {
                    defaultAgent: value === INHERIT ? null : value,
                  },
                },
              })
            }
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              <SelectItem value={INHERIT}>
                {t("settings.defaultAgent.inherit")}
              </SelectItem>
              {(agents.data ?? []).map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        {/* 没有语言服务器就明说，不在编辑器里摆假的补全入口（设计 §2、§4）。 */}
        <SettingsRow label={t("lsp.title")} footnote={t("lsp.description")}>
          <Badge variant="outline">
            {languageService.isPending
              ? t("lsp.probing")
              : t("lsp.unavailable")}
          </Badge>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
