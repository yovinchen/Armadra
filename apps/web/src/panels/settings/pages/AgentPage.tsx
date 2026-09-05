import * as React from "react";
import { Plus } from "lucide-react";
import {
  AGENT_IDS,
  supportedPermissionModes,
  customAgentSchema,
  type BuiltinAgentId,
  type AgentCapability,
  type CustomAgent,
  type PermissionMode,
} from "@armadra/shared";
import { toast } from "sonner";
import { CapabilityInheritance } from "@/agent/context-usage/CapabilityInheritance";

import { useAgentsQuery } from "../../../app/use-agents";
import {
  AGENT_MODES,
  usePreferencesStore,
  useT,
  type AgentMode,
} from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useSubpage } from "../subpage";
import { useRuntimeSettings } from "../use-runtime-settings";
import { CONTROL_WIDTH } from "./GeneralPage";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";

/**
 * 设置 → Agent（§24.1）。
 *
 * 每个内置 CLI 一行：三态（默认 / 启用 / 禁用）+ 自定义启动命令；
 * 下面是全局的默认 Agent 与默认权限模式；最后是自定义 Agent 列表，
 * 「添加 / 点一行」推入同一右栏里的子页，而不是叠一层对话框。
 */
export function AgentPage() {
  const t = useT();
  const agents = useAgentsQuery();
  const subpage = useSubpage();
  const { settings, save } = useRuntimeSettings();

  const modes = usePreferencesStore((state) => state.agentModes);
  const setAgentMode = usePreferencesStore((state) => state.setAgentMode);
  const overrides = usePreferencesStore((state) => state.launchOverrides);
  const setLaunchOverride = usePreferencesStore(
    (state) => state.setLaunchOverride,
  );
  const defaultAgentId = usePreferencesStore((state) => state.defaultAgentId);
  const setDefaultAgentId = usePreferencesStore(
    (state) => state.setDefaultAgentId,
  );
  const permissionMode = usePreferencesStore(
    (state) => state.defaultPermissionMode,
  );
  const setPermissionMode = usePreferencesStore(
    (state) => state.setDefaultPermissionMode,
  );

  const list = agents.data ?? [];
  // 自定义 Agent 也在 `GET /api/agents` 里（§24.1），但三态、启动命令这两组
  // 只对内置 CLI 有意义，自定义的在下面自己那一组里维护。
  const builtins = React.useMemo(
    () => list.filter((agent) => !agent.baseAgent),
    [list],
  );
  const custom = React.useMemo(
    () => settings.data?.agents?.custom ?? [],
    [settings.data],
  );

  const selectedAgentId = defaultAgentId ?? list[0]?.id ?? "claude";
  const selectedBase =
    list.find((agent) => agent.id === selectedAgentId)?.baseAgent ??
    selectedAgentId;
  const permissionModes = supportedPermissionModes(selectedBase);
  const effectivePermission = permissionModes.includes(permissionMode)
    ? permissionMode
    : "default";

  React.useEffect(() => {
    if (effectivePermission !== permissionMode)
      setPermissionMode(effectivePermission);
  }, [effectivePermission, permissionMode, setPermissionMode]);

  if (subpage.current?.startsWith("agent:")) {
    return (
      <CustomAgentForm
        reference={subpage.current.slice("agent:".length)}
        custom={custom}
        disabled={!settings.data}
        onSubmit={(next) => {
          save.mutate({ agents: { custom: next } });
          subpage.close();
        }}
        onCancel={subpage.close}
      />
    );
  }

  return (
    <>
      <SettingsGroup>
        {builtins.map((agent, index) => (
          <SettingsRow
            key={agent.id}
            label={
              <span className="flex items-center gap-2">{agent.label}</span>
            }
            footnote={index === 0 ? t("settings.agentMode.note") : undefined}
          >
            <ToggleGroup
              type="single"
              size="sm"
              spacing={0}
              variant="outline"
              value={modes[agent.id] ?? "default"}
              aria-label={agent.label}
              onValueChange={(value) => {
                if (value) setAgentMode(agent.id, value as AgentMode);
              }}
            >
              {AGENT_MODES.map((mode) => (
                <ToggleGroupItem key={mode} value={mode}>
                  {t(`settings.agentMode.${mode}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title={t("settings.launchCommand")}>
        {builtins.map((agent) => (
          <SettingsRow key={agent.id} label={agent.label}>
            <Input
              className="h-8 w-[240px] text-xs"
              aria-label={`${agent.label} ${t("settings.launchCommand")}`}
              placeholder={agent.resolvedPath ?? agent.launchCmd}
              value={overrides[agent.id] ?? ""}
              onChange={(event) =>
                setLaunchOverride(agent.id, event.target.value)
              }
            />
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow label={t("settings.defaultAgent")}>
          <Select
            value={selectedAgentId}
            onValueChange={(id) => {
              const base =
                list.find((agent) => agent.id === id)?.baseAgent ?? id;
              if (!supportedPermissionModes(base).includes(permissionMode))
                setPermissionMode("default");
              setDefaultAgentId(id);
            }}
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {list.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow label={t("settings.defaultPermission")}>
          <Select
            value={effectivePermission}
            onValueChange={(value) =>
              setPermissionMode(value as PermissionMode)
            }
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {permissionModes.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(`permission.${mode}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.customAgents")}>
        {custom.map((agent) => (
          <SettingsRow
            key={agent.id}
            label={
              <span className="flex items-center gap-2">{agent.label}</span>
            }
            onClick={() => subpage.open("agent", agent.id)}
          >
            <span className="text-[11px] text-muted-foreground">
              {agent.launchCmd}
            </span>
          </SettingsRow>
        ))}
        {custom.length === 0 && (
          <SettingsRow label={t("settings.customAgent.empty")} />
        )}
        <SettingsRow label={null}>
          <Button
            variant="secondary"
            size="sm"
            disabled={!settings.data}
            onClick={() => subpage.open("agent", "new")}
          >
            <Plus />
            {t("settings.customAgent.add")}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

/* -------------------------------- 自定义 Agent ---------------------------- */

interface AgentForm {
  label: string;
  launchCmd: string;
  args: string;
  env: string;
  baseAgent: BuiltinAgentId;
  disabledCapabilities?: AgentCapability[];
}

const EMPTY_FORM: AgentForm = {
  label: "",
  launchCmd: "",
  args: "",
  env: "",
  baseAgent: "claude",
};

function toForm(agent: CustomAgent | undefined): AgentForm {
  if (!agent) return EMPTY_FORM;
  return {
    label: agent.label,
    launchCmd: agent.launchCmd,
    args: agent.args.join(" "),
    env: envToText(agent),
    baseAgent: agent.baseAgent,
    disabledCapabilities: agent.disabledCapabilities,
  };
}

/** `KEY=value` 一行一条。 */
function envToText(agent: CustomAgent): string {
  if (!agent.env) return "";
  return Object.entries(agent.env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    env[trimmed.slice(0, separator).trim()] = trimmed
      .slice(separator + 1)
      .trim();
  }
  return env;
}

/** 表单 → 自定义 Agent。校验用的是 shared 的 schema，和 Runtime 同一套规则。 */
export function parseAgentForm(
  form: AgentForm,
  id: string,
): CustomAgent | null {
  const args = form.args.trim().split(/\s+/).filter(Boolean);
  const env = parseEnvText(form.env);
  const parsed = customAgentSchema.safeParse({
    id,
    label: form.label.trim(),
    launchCmd: form.launchCmd.trim(),
    args,
    baseAgent: form.baseAgent,
    ...(form.disabledCapabilities
      ? { disabledCapabilities: form.disabledCapabilities }
      : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function CustomAgentForm({
  reference,
  custom,
  disabled,
  onSubmit,
  onCancel,
}: {
  reference: string;
  custom: readonly CustomAgent[];
  disabled: boolean;
  onSubmit: (next: CustomAgent[]) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const existing = custom.find((agent) => agent.id === reference);
  const [form, setForm] = React.useState<AgentForm>(() => toForm(existing));
  const [pendingDelete, setPendingDelete] = React.useState(false);

  const set = (key: keyof AgentForm) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const fields: Array<{ key: "label" | "launchCmd" | "args"; label: string }> =
    [
      { key: "label", label: t("settings.customAgent.name") },
      { key: "launchCmd", label: t("settings.customAgent.command") },
      { key: "args", label: t("settings.customAgent.args") },
    ];

  return (
    <>
      <SettingsGroup>
        {fields.map((field) => (
          <SettingsRow key={field.key} label={field.label}>
            <Input
              className="h-8 w-[280px] text-xs"
              aria-label={field.label}
              value={form[field.key]}
              onChange={(event) => set(field.key)(event.target.value)}
            />
          </SettingsRow>
        ))}

        <SettingsRow label={t("settings.customAgent.env")}>
          <Input
            className="h-8 w-[280px] text-xs"
            aria-label={t("settings.customAgent.env")}
            placeholder="KEY=value"
            value={form.env}
            onChange={(event) => set("env")(event.target.value)}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.customAgent.base")}>
          <Select
            value={form.baseAgent}
            onValueChange={(value) =>
              setForm((current) => ({
                ...current,
                baseAgent: value as BuiltinAgentId,
              }))
            }
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {AGENT_IDS.map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <div className="px-3 py-2">
          <CapabilityInheritance
            baseAgent={form.baseAgent}
            disabledCapabilities={form.disabledCapabilities ?? []}
            disabled={disabled}
            onChange={(disabledCapabilities) =>
              setForm((current) => ({ ...current, disabledCapabilities }))
            }
          />
        </div>
      </SettingsGroup>

      <div className="flex items-center justify-between gap-2">
        <div>
          {existing && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setPendingDelete(true)}
            >
              {t("settings.customAgent.delete")}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("dialog.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => {
              const id =
                existing?.id ??
                `custom:${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
              const agent = parseAgentForm(form, id);
              if (!agent) {
                toast.error(t("settings.customAgent.invalid"));
                return;
              }
              onSubmit(
                existing
                  ? custom.map((entry) =>
                      entry.id === existing.id ? agent : entry,
                    )
                  : [...custom, agent],
              );
            }}
          >
            {t("dialog.save")}
          </Button>
        </div>
      </div>

      <AlertDialog open={pendingDelete} onOpenChange={setPendingDelete}>
        <AlertDialogContent className="z-[var(--z-dialog)]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.customAgent.deleteTitle", {
                name: existing?.label ?? "",
              })}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("dialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                onSubmit(custom.filter((entry) => entry.id !== existing?.id))
              }
            >
              {t("settings.customAgent.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
