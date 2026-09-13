import {
  THEME_PREFERENCES,
  usePreferencesStore,
  useT,
  type ThemePreference,
} from "../../../app/preferences-store";
import { LOCALES, type Locale } from "../../../i18n";
import { useCanvasStore } from "../../../store/canvas-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Switch } from "@/ui/switch";

/** 右侧控件统一宽度，让一页里的 Select 右边缘对齐（§24.2 的 8pt 网格）。 */
export const CONTROL_WIDTH = "w-[168px]";

/**
 * 设置 → 通用（§24.1）：主题、语言、侧栏、用量、恢复上次工作空间、
 * 系统文件、开屏动画。
 */
export function GeneralPage() {
  const t = useT();
  const theme = usePreferencesStore((state) => state.theme);
  const setTheme = usePreferencesStore((state) => state.setTheme);
  const locale = usePreferencesStore((state) => state.locale);
  const setLocale = usePreferencesStore((state) => state.setLocale);
  const showUsage = usePreferencesStore((state) => state.showUsage);
  const setShowUsage = usePreferencesStore((state) => state.setShowUsage);
  const restore = usePreferencesStore((state) => state.restoreLastWorkspace);
  const setRestore = usePreferencesStore(
    (state) => state.setRestoreLastWorkspace,
  );
  const splash = usePreferencesStore((state) => state.splashAnimation);
  const setSplash = usePreferencesStore((state) => state.setSplashAnimation);
  const systemFiles = usePreferencesStore((state) => state.showSystemFiles);
  const setSystemFiles = usePreferencesStore(
    (state) => state.setShowSystemFiles,
  );
  // 侧栏与 ⌘⇧L / 控制簇按钮共用同一个面板状态；`setPanel` 自己会把
  // 「展开与否」写进偏好，所以这里改的既是当前状态也是下次打开的默认。
  const sidebarOpen =
    useCanvasStore((state) => state.panels.sidebar) === "open";
  const setPanel = useCanvasStore((state) => state.setPanel);

  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("settings.theme")}>
          <Select
            value={theme}
            onValueChange={(value) => setTheme(value as ThemePreference)}
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {THEME_PREFERENCES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`settings.theme.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow label={t("settings.locale")}>
          <Select
            value={locale}
            onValueChange={(value) => setLocale(value as Locale)}
          >
            <SelectTrigger size="sm" className={CONTROL_WIDTH}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {LOCALES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`settings.locale.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow label={t("settings.sidebar")}>
          <Switch
            checked={sidebarOpen}
            aria-label={t("settings.sidebar")}
            onCheckedChange={(next) =>
              setPanel("sidebar", next ? "open" : "collapsed")
            }
          />
        </SettingsRow>

        <SettingsRow label={t("settings.showUsage")}>
          <Switch
            checked={showUsage}
            aria-label={t("settings.showUsage")}
            onCheckedChange={setShowUsage}
          />
        </SettingsRow>

        <SettingsRow
          label={t("settings.restoreWorkspace")}
          footnote={t("settings.restoreWorkspace.note")}
        >
          <Switch
            checked={restore}
            aria-label={t("settings.restoreWorkspace")}
            onCheckedChange={setRestore}
          />
        </SettingsRow>

        <SettingsRow
          label={t("settings.showSystemFiles")}
          footnote={t("settings.showSystemFiles.note")}
        >
          <Switch
            checked={systemFiles}
            aria-label={t("settings.showSystemFiles")}
            onCheckedChange={setSystemFiles}
          />
        </SettingsRow>

        <SettingsRow
          label={t("settings.splashAnimation")}
          footnote={t("settings.splashAnimation.note")}
        >
          <Switch
            checked={splash}
            aria-label={t("settings.splashAnimation")}
            onCheckedChange={setSplash}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
