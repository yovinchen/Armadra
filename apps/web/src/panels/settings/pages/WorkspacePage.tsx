import { WorkspaceExecution } from "./WorkspaceExecution";
import { LanguageServicePanel } from "./LanguageServicePanel";
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
      </SettingsGroup>
      {/* 每种语言一行：有什么、缺什么、能不能启动（语言服务设计 §4.2）。 */}
      <LanguageServicePanel workspaceId={workspaceId} />
    </>
  );
}
