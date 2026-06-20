import { Languages, Monitor, Moon, Sun } from "lucide-react";
import { usePreferences, type ThemePreference } from "./Preferences";

const themeIcons = { system: Monitor, light: Sun, dark: Moon };

export function PreferenceControls({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, theme, setTheme, t } = usePreferences();
  const ThemeIcon = themeIcons[theme];
  const nextTheme: Record<ThemePreference, ThemePreference> = {
    system: "light",
    light: "dark",
    dark: "system",
  };
  const themeLabel = t(`preferences.${theme}`);
  return (
    <div className={`preference-controls${compact ? " is-compact" : ""}`}>
      <button
        type="button"
        className="icon-button"
        aria-label={`${t("preferences.theme")}: ${themeLabel}`}
        title={`${t("preferences.theme")}: ${themeLabel}`}
        onClick={() => setTheme(nextTheme[theme])}
      >
        <ThemeIcon size={16} />
      </button>
      <button
        type="button"
        className="language-button"
        aria-label={`${t("preferences.language")}: ${locale === "zh-CN" ? t("preferences.zh") : t("preferences.en")}`}
        onClick={() => setLocale(locale === "zh-CN" ? "en" : "zh-CN")}
      >
        <Languages size={15} />
        <span>{locale === "zh-CN" ? "中" : "EN"}</span>
      </button>
    </div>
  );
}
