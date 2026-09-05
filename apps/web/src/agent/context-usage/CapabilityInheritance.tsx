import {
  AGENT_REGISTRY,
  type AgentCapability,
  type BuiltinAgentId,
} from "@armadra/shared";
import { useT } from "@/app/preferences-store";

export function CapabilityInheritance({
  baseAgent,
  disabledCapabilities,
  onChange,
  disabled = false,
}: {
  baseAgent: BuiltinAgentId;
  disabledCapabilities: readonly AgentCapability[];
  onChange: (disabled: AgentCapability[]) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-2">
      <legend className="text-sm font-medium">
        {t("context.capabilities")}
      </legend>
      <p className="max-w-prose text-xs text-muted-foreground">
        {t("context.capabilityNote")}
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {AGENT_REGISTRY[baseAgent].capabilities.map((capability) => (
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
            {t(`context.capability.${capability}`)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
