import {
  TERMINAL_CURSOR_STYLES,
  TERMINAL_FONT_SIZE_RANGE,
  TERMINAL_LINE_HEIGHT_RANGE,
  usePreferencesStore,
  useT,
  type TerminalCursorStyle,
} from "../../../app/preferences-store";
import { RENDER_BUDGET_CHOICES } from "../../../terminal/render-budget";
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

/**
 * `settings.terminal.backend`（§15.1 + T01）。
 *
 * `sessionHost` 只有 Windows 有：会话归 `armadra-session-host` 持有，关掉
 * 窗口甚至重启 Runtime 都不结束 CLI。选它的机器上 `auto` 已经是它，显式选
 * 是为了「起不来时报错，而不是悄悄退回会随进程一起死的直连」。
 */
const TERMINAL_BACKENDS = ["auto", "tmux", "direct", "sessionHost"] as const;
type TerminalBackend = (typeof TERMINAL_BACKENDS)[number];

/**
 * 会话休眠等待时长（T03，宿主设计 §7.2）。
 *
 * 过了这么久还没有任何客户端附着，Runtime 就把这个会话的输出投递放慢。
 * **进程不受影响**，回放缓冲照留，一个字节都不丢——只是不再为没人看的画面
 * 每 16 毫秒醒一次。「关闭」是真的关闭，不是「立刻休眠」。
 */
const DORMANT_CHOICES = [
  { seconds: 0, key: "terminal.settings.dormant.off" },
  { seconds: 30, key: "terminal.settings.dormant.30s" },
  { seconds: 120, key: "terminal.settings.dormant.2m" },
  { seconds: 600, key: "terminal.settings.dormant.10m" },
] as const;

/**
 * 防休眠策略（T02，终端宿主设计 §9）。
 *
 * 默认是 `manual`：不经用户明确要求，没有任何东西可以让这台机器不睡。
 * 无论选哪一档，生效的都只有「阻止系统空闲睡眠」这一件事。
 */
const POWER_POLICIES = [
  "never",
  "agentSessions",
  "automation",
  "manual",
] as const;
type PowerPolicyChoice = (typeof POWER_POLICIES)[number];

/** 采样间隔。设计 §8 的默认值是 2 秒；关掉面板就不采样，所以这里不给「关」。 */
const SAMPLE_INTERVALS = [1_000, 2_000, 5_000, 15_000] as const;

const GIB = 1024 * 1024 * 1024;
/**
 * 内存提醒阈值（路线图 §4.3「默认 2 GB，可设」）。
 *
 * 这条线是「值得看一眼」，不是「出问题了」：一个跑着构建的 Agent 越过 2 GB
 * 完全正常。所以越线只有变色和一条按会话去重的提醒，没有任何自动处置。
 */
const MEMORY_THRESHOLDS = [1, 2, 4, 8, 16] as const;

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
  // 阈值只影响本机的徽标与提醒，所以和终端外观一样存在本地，不进 Runtime。
  const memoryWarnBytes = usePreferencesStore(
    (state) => state.sessionMemoryWarnBytes,
  );
  const setMemoryWarnBytes = usePreferencesStore(
    (state) => state.setSessionMemoryWarnBytes,
  );
  // 同理：能同时开几个 WebGL 上下文是这台机器的属性，不是账号偏好。
  const renderBudget = usePreferencesStore((state) => state.renderBudget);
  const setRenderBudget = usePreferencesStore((state) => state.setRenderBudget);
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

        <SettingsRow
          label={t("terminal.settings.dormantAfter")}
          footnote={t("terminal.settings.dormantAfterHint")}
        >
          <Select
            value={String(runtimeTerminal?.dormantAfterSeconds ?? 120)}
            disabled={!settings.data}
            onValueChange={(value) =>
              save.mutate({ terminal: { dormantAfterSeconds: Number(value) } })
            }
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {DORMANT_CHOICES.map((choice) => (
                <SelectItem key={choice.seconds} value={String(choice.seconds)}>
                  {t(choice.key)}
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
        <SettingsRow
          label={t("resources.power.policyLabel")}
          footnote={t("resources.power.policyHint")}
        >
          <Select
            value={settings.data?.power?.policy ?? "manual"}
            disabled={!settings.data}
            onValueChange={(value) =>
              save.mutate({ power: { policy: value as PowerPolicyChoice } })
            }
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {POWER_POLICIES.map((policy) => (
                <SelectItem key={policy} value={policy}>
                  {t(`resources.power.policy.${policy}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow
          label={t("resources.intervalLabel")}
          footnote={t("resources.intervalHint")}
        >
          <Select
            value={String(settings.data?.resources?.intervalMs ?? 2_000)}
            disabled={!settings.data}
            onValueChange={(value) =>
              save.mutate({ resources: { intervalMs: Number(value) } })
            }
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {SAMPLE_INTERVALS.map((interval) => (
                <SelectItem key={interval} value={String(interval)}>
                  {t("resources.interval.value", { value: interval / 1_000 })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow
          label={t("resources.memory.thresholdLabel")}
          footnote={t("resources.memory.thresholdHint")}
        >
          <Select
            value={String(memoryWarnBytes)}
            onValueChange={(value) => setMemoryWarnBytes(Number(value))}
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {MEMORY_THRESHOLDS.map((gigabytes) => (
                <SelectItem key={gigabytes} value={String(gigabytes * GIB)}>
                  {t("resources.memory.threshold.value", { value: gigabytes })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow
          label={t("terminal.settings.renderBudget")}
          footnote={t("terminal.settings.renderBudgetHint")}
        >
          <Select
            value={String(renderBudget)}
            onValueChange={(value) => setRenderBudget(Number(value))}
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {RENDER_BUDGET_CHOICES.map((slots) => (
                <SelectItem key={slots} value={String(slots)}>
                  {slots}
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
