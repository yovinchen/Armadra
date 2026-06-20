import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DEFAULT_LOCALE, LOCALES, messages, type Locale } from "../i18n";
import {
  DEFAULT_SUMMARY_THRESHOLD,
  useCanvasStore,
} from "../store/canvas-store";

export type { Locale };
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const LOCALE_KEY = "ai-canvas-locale";
const THEME_KEY = "ai-canvas-theme";
const SUMMARY_KEY = "ai-canvas-summary-threshold";

/** Setting range from plan §1.4 / SPEC §3: the canvas summarises below this. */
export const MIN_SUMMARY_THRESHOLD = 0.3;
export const MAX_SUMMARY_THRESHOLD = 0.9;

type PreferencesValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  resolvedTheme: ResolvedTheme;
  summaryThreshold: number;
  setSummaryThreshold: (threshold: number) => void;
  t: (key: string, values?: Record<string, string | number>) => string;
};

const PreferencesContext = createContext<PreferencesValue | null>(null);

function stored<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SUMMARY_THRESHOLD;
  return Math.min(
    MAX_SUMMARY_THRESHOLD,
    Math.max(MIN_SUMMARY_THRESHOLD, Math.round(value * 100) / 100),
  );
}

function storedThreshold(): number {
  try {
    const raw = localStorage.getItem(SUMMARY_KEY);
    if (!raw) return DEFAULT_SUMMARY_THRESHOLD;
    return clampThreshold(Number.parseFloat(raw));
  } catch {
    return DEFAULT_SUMMARY_THRESHOLD;
  }
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() =>
    stored(LOCALE_KEY, LOCALES, DEFAULT_LOCALE),
  );
  const [theme, setThemeState] = useState<ThemePreference>(() =>
    stored(THEME_KEY, ["system", "light", "dark"] as const, "system"),
  );
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    systemColorScheme(),
  );
  const [summaryThreshold, setThresholdState] =
    useState<number>(storedThreshold);
  const resolvedTheme = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemTheme(media.matches ? "dark" : "light");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
    document.documentElement.lang = locale;
  }, [locale, resolvedTheme]);

  // The canvas reads the threshold from the store (plan §4), the setting lives
  // here; keep the two in sync in one place.
  useEffect(() => {
    useCanvasStore.getState().setSummaryThreshold(summaryThreshold);
  }, [summaryThreshold]);

  const value = useMemo<PreferencesValue>(
    () => ({
      locale,
      setLocale(next) {
        localStorage.setItem(LOCALE_KEY, next);
        setLocaleState(next);
      },
      theme,
      setTheme(next) {
        localStorage.setItem(THEME_KEY, next);
        setThemeState(next);
      },
      resolvedTheme,
      summaryThreshold,
      setSummaryThreshold(next) {
        const clamped = clampThreshold(next);
        localStorage.setItem(SUMMARY_KEY, String(clamped));
        setThresholdState(clamped);
      },
      t(key, values = {}) {
        const template = messages[locale][key] ?? messages.en[key] ?? key;
        return Object.entries(values).reduce(
          (text, [name, replacement]) =>
            text.replaceAll(`{${name}}`, String(replacement)),
          template,
        );
      },
    }),
    [locale, resolvedTheme, summaryThreshold, theme],
  );

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

function systemColorScheme(): ResolvedTheme {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function usePreferences() {
  const context = useContext(PreferencesContext);
  if (!context)
    throw new Error("usePreferences must be used inside PreferencesProvider");
  return context;
}
