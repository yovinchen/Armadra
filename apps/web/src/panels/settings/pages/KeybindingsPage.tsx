import * as React from "react";

import { useT } from "../../../app/preferences-store";
import {
  COMMANDS,
  commandKeysLabel,
  type CommandId,
  type CommandScope,
} from "../../../keybindings";
import { chordFromEvent, keymapConflicts, toKeymap } from "../keymap";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { Badge } from "@/ui/badge";
import { Kbd } from "@/ui/kbd";
import { cn } from "@/lib/cn";

const SCOPES: readonly CommandScope[] = ["app", "canvas", "terminal", "scm"];

/**
 * 设置 → 快捷键（§24.1）。
 *
 * 按 scope 分组的命令表。点键位进入录制态：下一个带修饰键的组合就是新键位，
 * Esc 取消，Backspace 恢复默认（发 `null` 让 Runtime 删掉这条覆盖）。
 * 同一 scope 里撞车的两条都挂一个 destructive Badge——不自动改判谁赢，
 * 用户看得见才改得动。
 */
export function KeybindingsPage() {
  const t = useT();
  const { settings, save } = useRuntimeSettings();
  const keymap = React.useMemo(
    () => toKeymap(settings.data?.keymap),
    [settings.data],
  );
  const conflicts = React.useMemo(() => keymapConflicts(keymap), [keymap]);
  const [recording, setRecording] = React.useState<CommandId | null>(null);

  // 录制期间在捕获阶段独占键盘，否则按下的组合会先被应用自己的快捷键吃掉。
  React.useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        return;
      }
      if (event.key === "Backspace") {
        save.mutate({ keymap: { [recording]: null } });
        setRecording(null);
        return;
      }
      const chord = chordFromEvent(event);
      if (!chord) return;
      save.mutate({ keymap: { [recording]: chord } });
      setRecording(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, save]);

  return (
    <>
      {SCOPES.map((scope) => (
        <SettingsGroup key={scope} title={t(`settings.scope.${scope}`)}>
          {COMMANDS.filter((command) => command.scope === scope).map(
            (command, index) => (
              <SettingsRow
                key={command.id}
                label={t(command.labelKey)}
                footnote={
                  scope === "app" && index === 0
                    ? t("settings.shortcut.note")
                    : undefined
                }
              >
                {conflicts.has(command.id) && (
                  <Badge variant="destructive">
                    {t("settings.shortcut.conflict")}
                  </Badge>
                )}
                <button
                  type="button"
                  data-recording={recording === command.id}
                  aria-label={t(command.labelKey)}
                  className={cn(
                    "rounded-md px-1 py-0.5 transition-colors hover:bg-muted/60",
                    "data-[recording=true]:bg-muted",
                  )}
                  onClick={() =>
                    setRecording((current) =>
                      current === command.id ? null : command.id,
                    )
                  }
                >
                  {recording === command.id ? (
                    <span className="text-[11px] text-muted-foreground">
                      {t("settings.shortcut.recording")}
                    </span>
                  ) : (
                    <Kbd>
                      {commandKeysLabel(command.id, { keymap }) ||
                        t("settings.shortcut.unbound")}
                    </Kbd>
                  )}
                </button>
              </SettingsRow>
            ),
          )}
        </SettingsGroup>
      ))}
    </>
  );
}
