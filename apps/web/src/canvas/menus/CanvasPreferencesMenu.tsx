import * as React from "react";

import {
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/ui/dropdown-menu";
import {
  THEME_PREFERENCES,
  WHITEBOARD_BACKGROUNDS,
  WHITEBOARD_INPUT_MODES,
  usePreferencesStore,
  useT,
  type ThemePreference,
  type WhiteboardBackground,
  type WhiteboardInputMode,
  type WhiteboardPreferences,
} from "@/app/preferences-store";
import { commandKeysLabel, type CommandId } from "@/keybindings";

/**
 * 画布偏好菜单（2026-09-05 用户反馈：「白板引擎的原生能力并没有加入到
 * 系统中……右侧的设置主要就是展开这一个里面的配置」；React Flow 计划 F31）。
 *
 * 八个勾选项 + 三个子菜单（主题 / 画布背景 / 输入设备）。每一项都写
 * `preferences-store` 的 `whiteboard` 段，由 `use-canvas-preferences` 与
 * `flow/flow-options.ts` 单向推给画布；快捷键（Q / ⌘' / ⌘.）改的也是同一
 * 处，所以这个菜单的勾选状态与设置 → 白板永远一致。
 *
 * 换引擎删掉的四项（调试面板、增强辅助、缩放方向反转、手绘 / 整洁风格档）
 * 在 React Flow 下没有对应能力（§2.10）。「辅助功能」子菜单里只剩「动画」
 * 一项，所以那一层也拆掉，动画直接进勾选组。
 *
 * 只吐 `<DropdownMenuContent>`：调用方（`shell/ControlsCluster`）自己套
 * `<DropdownMenu>` 与触发钮，这样触发钮能保持工具簇里那一排的样子。
 */

/** 一个勾选项：偏好里的布尔键 + 文案键 + （可选）对应的命令。 */
interface ToggleSpec {
  key: BooleanWhiteboardKey;
  labelKey: string;
  command?: CommandId;
}

/** `WhiteboardPreferences` 里值为 boolean 的键。 */
type BooleanWhiteboardKey = {
  [K in keyof WhiteboardPreferences]: WhiteboardPreferences[K] extends boolean
    ? K
    : never;
}[keyof WhiteboardPreferences];

/**
 * 顺序照抄旧引擎的偏好子菜单，用户从别处过来时找得到同一行。
 * 只有三条在 `keybindings.ts` 里真的绑了键，其余不显示键位提示。
 */
export const CANVAS_PREFERENCE_TOGGLES: readonly ToggleSpec[] = [
  { key: "snap", labelKey: "wb.snap" },
  {
    key: "toolLock",
    labelKey: "wb.toolLock",
    command: "canvas.toggleToolLock",
  },
  { key: "grid", labelKey: "wb.grid", command: "canvas.toggleGrid" },
  { key: "wrap", labelKey: "wb.wrap" },
  { key: "focus", labelKey: "wb.focus", command: "canvas.toggleFocus" },
  { key: "edgeScroll", labelKey: "wb.edgeScroll" },
  { key: "dynamicSize", labelKey: "wb.dynamicSize" },
  { key: "pasteAtCursor", labelKey: "wb.pasteAtCursor" },
  { key: "animation", labelKey: "wb.animation" },
];

export function CanvasPreferencesMenu() {
  const t = useT();
  const whiteboard = usePreferencesStore((state) => state.whiteboard);
  const setWhiteboard = usePreferencesStore(
    (state) => state.setWhiteboardPreference,
  );
  const theme = usePreferencesStore((state) => state.theme);
  const setTheme = usePreferencesStore((state) => state.setTheme);

  return (
    <DropdownMenuContent
      side="left"
      align="start"
      className="z-[var(--z-menu)] w-auto min-w-52"
    >
      {CANVAS_PREFERENCE_TOGGLES.map((toggle) => (
        <PreferenceToggle
          key={toggle.key}
          spec={toggle}
          checked={whiteboard[toggle.key]}
          onChange={(next) => setWhiteboard(toggle.key, next)}
        />
      ))}

      <DropdownMenuSeparator />

      <DropdownMenuSub>
        <DropdownMenuSubTrigger>{t("wb.theme")}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="z-[var(--z-menu)]">
          <DropdownMenuRadioGroup
            value={theme}
            onValueChange={(value) => setTheme(value as ThemePreference)}
          >
            {THEME_PREFERENCES.map((option) => (
              <DropdownMenuRadioItem key={option} value={option}>
                {t(`settings.theme.${option}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger>{t("wb.background")}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="z-[var(--z-menu)]">
          <DropdownMenuRadioGroup
            value={whiteboard.background}
            onValueChange={(value) =>
              setWhiteboard("background", value as WhiteboardBackground)
            }
          >
            {WHITEBOARD_BACKGROUNDS.map((option) => (
              <DropdownMenuRadioItem key={option} value={option}>
                {t(`settings.whiteboard.background.${option}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger>{t("wb.input")}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="z-[var(--z-menu)]">
          <DropdownMenuRadioGroup
            value={whiteboard.inputMode}
            onValueChange={(value) =>
              setWhiteboard("inputMode", value as WhiteboardInputMode)
            }
          >
            {WHITEBOARD_INPUT_MODES.map((option) => (
              <DropdownMenuRadioItem key={option} value={option}>
                {t(`wb.input.${option}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </DropdownMenuContent>
  );
}

function PreferenceToggle({
  spec,
  checked,
  onChange,
}: {
  spec: ToggleSpec;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const t = useT();
  // 没绑键的命令返回空串，那一行就不显示提示（不写死 Q / ⌘' / ⌘.）。
  const keys = spec.command ? commandKeysLabel(spec.command) : "";
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      // 勾选后菜单不收起：这一组常常要连着改好几项。
      onSelect={(event) => event.preventDefault()}
      onCheckedChange={onChange}
    >
      <span className="flex-1">{t(spec.labelKey)}</span>
      {keys ? <DropdownMenuShortcut>{keys}</DropdownMenuShortcut> : null}
    </DropdownMenuCheckboxItem>
  );
}
