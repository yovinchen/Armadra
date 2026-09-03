import {
  TERMINAL_CURSOR_STYLES,
  TERMINAL_FONT_SIZE_RANGE,
  TERMINAL_LINE_HEIGHT_RANGE,
  usePreferencesStore,
  useT,
  type TerminalCursorStyle,
} from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { CONTROL_WIDTH } from "./GeneralPage";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Switch } from "@/ui/switch";

/** `settings.terminal.backend` 的三个取值（§15.1）。 */
const TERMINAL_BACKENDS = ["auto", "tmux", "direct"] as const;
type TerminalBackend = (typeof TERMINAL_BACKENDS)[number];

/** 断开保留时长（分钟）——§15.2 的 `detachedGraceMinutes`。 */
const GRACE_CHOICES = [
  { minutes: 60, key: "settings.grace.1h" },
  { minutes: 720, key: "settings.grace.12h" },
  { minutes: 1_440, key: "settings.grace.1d" },
  { minutes: 10_080, key: "settings.grace.7d" },
] as const;

/**
 * 设置 → 终端（§24.1）。
 *
 * 上面一张卡是 Runtime 侧的会话策略（后端、断开保留），下面两张是纯本地的
 * 外观与键盘偏好：改一项 `TerminalSurface` 会重设 xterm options 并 fit 一次。
 */
export function TerminalPage() {
  const t = useT();
  const terminal = usePreferencesStore((state) => state.terminal);
  const set = usePreferencesStore((state) => state.setTerminalPreference);
  const { settings, save } = useRuntimeSettings();
  const runtimeTerminal = settings.data?.terminal;

  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("settings.terminalBackend")}>
          <Select
            value={runtimeTerminal?.backend ?? "auto"}
            disabled={!settings.data}
            onValueChange={(value) =>
              save.mutate({ terminal: { backend: value as TerminalBackend } })
            }
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {TERMINAL_BACKENDS.map((choice) => (
                <SelectItem key={choice} value={choice}>
                  {t(`settings.backend.${choice}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow label={t("settings.detachedGrace")}>
          <Select
            value={String(runtimeTerminal?.detachedGraceMinutes ?? 1_440)}
            disabled={!settings.data}
            onValueChange={(value) =>
              save.mutate({ terminal: { detachedGraceMinutes: Number(value) } })
            }
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {GRACE_CHOICES.map((choice) => (
                <SelectItem key={choice.minutes} value={String(choice.minutes)}>
                  {t(choice.key)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow label={t("terminal.settings.font")}>
          <Input
            className="h-8 w-[240px] text-xs"
            aria-label={t("terminal.settings.font")}
            value={terminal.fontFamily}
            onChange={(event) => set("fontFamily", event.target.value)}
          />
        </SettingsRow>

        <SettingsRow label={t("terminal.settings.fontSize")}>
          <Input
            type="number"
            className="h-8 w-[90px] text-xs"
            aria-label={t("terminal.settings.fontSize")}
            min={TERMINAL_FONT_SIZE_RANGE[0]}
            max={TERMINAL_FONT_SIZE_RANGE[1]}
            step={1}
            value={terminal.fontSize}
            onChange={(event) =>
              set(
                "fontSize",
                clamp(event.target.value, TERMINAL_FONT_SIZE_RANGE),
              )
            }
          />
        </SettingsRow>

        <SettingsRow label={t("terminal.settings.lineHeight")}>
          <Input
            type="number"
            className="h-8 w-[90px] text-xs"
            aria-label={t("terminal.settings.lineHeight")}
            min={TERMINAL_LINE_HEIGHT_RANGE[0]}
            max={TERMINAL_LINE_HEIGHT_RANGE[1]}
            step={0.05}
            value={terminal.lineHeight}
            onChange={(event) =>
              set(
                "lineHeight",
                clamp(event.target.value, TERMINAL_LINE_HEIGHT_RANGE),
              )
            }
          />
        </SettingsRow>

        <SettingsRow label={t("terminal.settings.cursor")}>
          <Select
            value={terminal.cursorStyle}
            onValueChange={(value) =>
              set("cursorStyle", value as TerminalCursorStyle)
            }
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {TERMINAL_CURSOR_STYLES.map((style) => (
                <SelectItem key={style} value={style}>
                  {t(`terminal.cursor.${style}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow label={t("terminal.settings.cursorBlink")}>
          <Switch
            checked={terminal.cursorBlink}
            aria-label={t("terminal.settings.cursorBlink")}
            onCheckedChange={(next) => set("cursorBlink", next)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow label={t("terminal.settings.optionAsMeta")}>
          <Switch
            checked={terminal.macOptionIsMeta}
            aria-label={t("terminal.settings.optionAsMeta")}
            onCheckedChange={(next) => set("macOptionIsMeta", next)}
          />
        </SettingsRow>

        <SettingsRow label={t("terminal.settings.webgl")}>
          <Switch
            checked={terminal.webgl}
            aria-label={t("terminal.settings.webgl")}
            onCheckedChange={(next) => set("webgl", next)}
          />
        </SettingsRow>

        <SettingsRow label={t("terminal.settings.copyOnSelect")}>
          <Switch
            checked={terminal.copyOnSelect}
            aria-label={t("terminal.settings.copyOnSelect")}
            onCheckedChange={(next) => set("copyOnSelect", next)}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

/** 输入框里随手打的值可能越界或不是数字；越界就夹回范围。 */
function clamp(raw: string, [min, max]: readonly [number, number]): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
