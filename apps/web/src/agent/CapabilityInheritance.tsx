import {
  AGENT_REGISTRY,
  resolveAgentCapabilities,
  type AgentCapability,
  type AgentProbe,
  type BuiltinAgentId,
} from "@armadra/shared";
import { useT } from "@/app/preferences-store";

/**
 * 继承的能力（Agent 自动化设计 §1）。
 *
 * 复选框只管一件事：自定义 Agent 可以关掉基础适配器已有的能力。旁边那行
 * 来源标签管另一件：这一项现在为什么是这个状态——基础适配器没有它、被这份
 * 自定义配置关掉了、CLI 版本探测答不上来，还是执行主机带不动。
 *
 * 「能力继承 UI 展示来源」是设计明确要求的：用户看到一个灰掉的开关时，得知道
 * 是自己关的还是环境不支持，否则只会反复去点它。
 */
export function CapabilityInheritance({
  baseAgent,
  disabledCapabilities,
  onChange,
  disabled = false,
  probe = null,
}: {
  baseAgent: BuiltinAgentId;
  disabledCapabilities: readonly AgentCapability[];
  onChange: (disabled: AgentCapability[]) => void;
  disabled?: boolean;
  /** `GET /api/agents` 上的 `--version` 探测结果；`null` = 还没探测过。 */
  probe?: AgentProbe | null;
}) {
  const t = useT();
  // 只列基础适配器真的声明过的能力：没声明的那些永远加不回来，把它们摆成
  // 一排关着的开关只会让人以为可以打开。
  const declared = AGENT_REGISTRY[baseAgent].capabilities;
  const resolved = resolveAgentCapabilities({
    baseAgent,
    disabledCapabilities,
    probe,
  });
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-2">
      <legend className="text-sm font-medium">{t("capability.title")}</legend>
      <p className="max-w-prose text-xs text-muted-foreground">
        {t("capability.note")}
      </p>
      <div className="flex flex-col gap-y-1">
        {declared.map((capability) => {
          const entry = resolved.find((item) => item.capability === capability);
          return (
            <label
              key={capability}
              className="flex min-h-8 cursor-pointer items-center gap-2 text-xs"
            >
              <input
                type="checkbox"
                checked={!disabledCapabilities.includes(capability)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? disabledCapabilities.filter(
                          (entry) => entry !== capability,
                        )
                      : [...new Set([...disabledCapabilities, capability])],
                  )
                }
              />
              <span className="min-w-0 flex-1 truncate">
                {t(`capability.name.${capability}`)}
              </span>
              {entry && (
                <span className="shrink-0 text-muted-foreground">
                  {t(`capability.state.${entry.state}`)} ·{" "}
                  {t(`capability.source.${entry.source}`)}
                </span>
              )}
            </label>
          );
        })}
      </div>
      {probe?.status !== "ok" && (
        <p className="max-w-prose text-xs text-muted-foreground">
          {t("capability.probeUnknown")}
        </p>
      )}
    </fieldset>
  );
}
