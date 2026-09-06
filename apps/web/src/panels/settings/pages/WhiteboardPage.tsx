import {
  WHITEBOARD_BACKGROUNDS,
  WHITEBOARD_COLORS,
  WHITEBOARD_GRID_SIZES,
  WHITEBOARD_INPUT_MODES,
  WHITEBOARD_SIZES,
  WHITEBOARD_STYLES,
  usePreferencesStore,
  useT,
  type WhiteboardBackground,
  type WhiteboardColor,
  type WhiteboardGridSize,
  type WhiteboardInputMode,
  type WhiteboardSize,
  type WhiteboardStyle,
} from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { CONTROL_WIDTH } from "./GeneralPage";
import { Button } from "@/ui/button";
import { ColorDot } from "@/ui/color-dot";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Switch } from "@/ui/switch";

/**
 * 白板 13 色在浅色底上的十六进制值（B2 抽到 `whiteboard/palette.ts`）。
 *
 * 色点只是设置页里的预览，不参与画布渲染，所以固定用浅色主题那一套：
 * 深色主题的同名色是同一个语义，换一套只会让色点和用户记住的颜色对不上。
 * `white` 在浅底上要靠边框才看得见，单独给一圈描边。
 */
const SWATCHES: Record<WhiteboardColor, string> = {
  black: "#1d1d1d",
  grey: "#9fa8b2",
  white: "#ffffff",
  blue: "#4465e9",
  "light-blue": "#4ba1f1",
  green: "#099268",
  "light-green": "#4cb05e",
  yellow: "#f1ac4b",
  orange: "#e16919",
  red: "#e03131",
  "light-red": "#f87777",
  violet: "#ae3ec9",
  "light-violet": "#e085f4",
};

/**
 * 设置 → 白板（2026-09-04 用户反馈：把 白板配置要能在系统里自主配置；
 * 2026-09-05：偏好里所有的设置都要能在系统里自主配置）。
 *
 * 四张卡：外观（背景、网格）、行为（吸附、工具锁定、选择换行、动态尺寸、
 * 粘贴至光标处、边缘滚动、专注模式）、辅助与输入（动画、增强辅助、输入
 * 设备、缩放反转、调试）、默认风格（手绘 / 整洁、颜色、粗细）。
 *
 * 前两张半与右上工具簇的画布偏好菜单是**同一份 store**，两处任改一处、
 * 另一处立刻跟着变；默认风格那一组只在这里出现（菜单里放不下）。
 * 界面语言不在这里——它静默跟随应用语言。
 */
export function WhiteboardPage() {
  const t = useT();
  const whiteboard = usePreferencesStore((state) => state.whiteboard);
  const set = usePreferencesStore((state) => state.setWhiteboardPreference);

  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("settings.whiteboard.background")}>
          <Select
            value={whiteboard.background}
            onValueChange={(value) =>
              set("background", value as WhiteboardBackground)
            }
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {WHITEBOARD_BACKGROUNDS.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`settings.whiteboard.background.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow label={t("settings.whiteboard.grid")}>
          <Switch
            checked={whiteboard.grid}
            aria-label={t("settings.whiteboard.grid")}
            onCheckedChange={(next) => set("grid", next)}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.whiteboard.gridSize")}>
          <Select
            value={String(whiteboard.gridSize)}
            disabled={!whiteboard.grid}
            onValueChange={(value) =>
              set("gridSize", Number(value) as WhiteboardGridSize)
            }
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {WHITEBOARD_GRID_SIZES.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {t(`settings.whiteboard.gridSize.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow label={t("settings.whiteboard.snap")}>
          <Switch
            checked={whiteboard.snap}
            aria-label={t("settings.whiteboard.snap")}
            onCheckedChange={(next) => set("snap", next)}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.whiteboard.toolLock")}>
          <Switch
            checked={whiteboard.toolLock}
            aria-label={t("settings.whiteboard.toolLock")}
            onCheckedChange={(next) => set("toolLock", next)}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.whiteboard.wrap")}>
          <Switch
            checked={whiteboard.wrap}
            aria-label={t("settings.whiteboard.wrap")}
            onCheckedChange={(next) => set("wrap", next)}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.whiteboard.dynamicSize")}>
          <Switch
            checked={whiteboard.dynamicSize}
            aria-label={t("settings.whiteboard.dynamicSize")}
            onCheckedChange={(next) => set("dynamicSize", next)}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.whiteboard.pasteAtCursor")}>
          <Switch
            checked={whiteboard.pasteAtCursor}
            aria-label={t("settings.whiteboard.pasteAtCursor")}
            onCheckedChange={(next) => set("pasteAtCursor", next)}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.whiteboard.edgeScroll")}>
          <Switch
            checked={whiteboard.edgeScroll}
            aria-label={t("settings.whiteboard.edgeScroll")}
            onCheckedChange={(next) => set("edgeScroll", next)}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.whiteboard.focus")}>
          <Switch
            checked={whiteboard.focus}
            aria-label={t("settings.whiteboard.focus")}
            onCheckedChange={(next) => set("focus", next)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow label={t("settings.whiteboard.animation")}>
          <Switch
            checked={whiteboard.animation}
            aria-label={t("settings.whiteboard.animation")}
            onCheckedChange={(next) => set("animation", next)}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.whiteboard.enhancedA11y")}>
          <Switch
            checked={whiteboard.enhancedA11y}
            aria-label={t("settings.whiteboard.enhancedA11y")}
            onCheckedChange={(next) => set("enhancedA11y", next)}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.whiteboard.inputMode")}>
          <Select
            value={whiteboard.inputMode}
            onValueChange={(value) =>
              set("inputMode", value as WhiteboardInputMode)
            }
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {WHITEBOARD_INPUT_MODES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`settings.whiteboard.inputMode.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow label={t("settings.whiteboard.zoomInverted")}>
          <Switch
            checked={whiteboard.zoomInverted}
            disabled={whiteboard.inputMode !== "mouse"}
            aria-label={t("settings.whiteboard.zoomInverted")}
            onCheckedChange={(next) => set("zoomInverted", next)}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.whiteboard.debug")}>
          <Switch
            checked={whiteboard.debug}
            aria-label={t("settings.whiteboard.debug")}
            onCheckedChange={(next) => set("debug", next)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow label={t("settings.whiteboard.style")}>
          <Select
            value={whiteboard.style}
            onValueChange={(value) => set("style", value as WhiteboardStyle)}
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {WHITEBOARD_STYLES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`settings.whiteboard.style.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow label={t("settings.whiteboard.defaultColor")}>
          <WhiteboardSwatches
            value={whiteboard.defaultColor}
            onChange={(color) => set("defaultColor", color)}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.whiteboard.defaultSize")}>
          <Select
            value={whiteboard.defaultSize}
            onValueChange={(value) =>
              set("defaultSize", value as WhiteboardSize)
            }
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {WHITEBOARD_SIZES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`settings.whiteboard.size.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

/**
 * 白板 13 色的色板。
 *
 * 没有复用 `ui/color-picker` 的 `ColorSwatches`：那一个的色值白名单是节点
 * 调色板的 7 色（`NODE_COLORS`），是画布控制 API 的契约，掺进白板的
 * 颜色名会把两套色板搅在一起。这里只复用 `ColorDot` 与 `Button`。
 */
function WhiteboardSwatches({
  value,
  onChange,
}: {
  value: WhiteboardColor;
  onChange: (color: WhiteboardColor) => void;
}) {
  const t = useT();
  return (
    <div
      role="radiogroup"
      aria-label={t("settings.whiteboard.defaultColor")}
      className="flex flex-wrap items-center justify-end gap-0.5"
    >
      {WHITEBOARD_COLORS.map((color) => {
        const selected = value === color;
        return (
          <Button
            key={color}
            variant="ghost"
            size="icon-sm"
            role="radio"
            aria-checked={selected}
            aria-label={t(`settings.whiteboard.color.${color}`)}
            title={t(`settings.whiteboard.color.${color}`)}
            onClick={() => onChange(color)}
          >
            <ColorDot
              color={SWATCHES[color]}
              size={14}
              selected={selected}
              className="border border-border"
            />
          </Button>
        );
      })}
    </div>
  );
}
