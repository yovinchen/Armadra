import { desktop } from "../../../web/src/i18n/desktop";

/**
 * The shell's wording, taken from the front end's catalogue.
 *
 * Migration design §2.3, last bullet: the strings the Tauri shell hardcoded
 * (`usage.rs`, `updates/notify.rs`) move into `apps/web/src/i18n/`, and the
 * main process only ever decides WHICH language to read. `apps/desktop` is not
 * allowed a second message catalogue — two catalogues drift, and the one the
 * user never sees is the one that stops being translated.
 *
 * Only the `desktop` module is imported, not `i18n/index.ts`: the main bundle
 * has no business carrying the whole front-end catalogue, and that module is
 * written so its only other import is a `import type`.
 */

export type ShellLocale = "zh-CN" | "en";

/**
 * Which of the two languages the product ships an OS tag means.
 *
 * Anything that is not Chinese is English — those are the two that exist, and
 * guessing a third would only produce untranslated text. Ported from
 * `usage.rs`'s `Locale::from_tag`.
 */
export function localeFromTag(tag: string | undefined | null): ShellLocale {
  return (tag ?? "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/**
 * One string. A missing key falls back to `zh-CN` and then to the key itself,
 * the same order `i18n/index.ts` uses: a menu item showing a key name is ugly,
 * but a blank one is unusable.
 */
export function shellText(locale: ShellLocale, key: string): string {
  return desktop[locale][key] ?? desktop["zh-CN"][key] ?? key;
}
