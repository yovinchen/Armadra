import { agent } from "./agent";
import { canvas } from "./canvas";
import { explorer } from "./explorer";
import { inspector } from "./inspector";
import { launcher } from "./launcher";
import { modals } from "./modals";
import { nodes } from "./nodes";
import { shell } from "./shell";
import { terminal } from "./terminal";

export type Locale = "zh-CN" | "en";

/** One flat namespace per feature area; see docs/redesign-plan.md §5. */
export type MessageModule = Record<Locale, Record<string, string>>;

const modules: MessageModule[] = [
  shell,
  launcher,
  canvas,
  nodes,
  agent,
  terminal,
  inspector,
  explorer,
  modals,
];

function merge(locale: Locale): Record<string, string> {
  return Object.assign(
    {},
    ...modules.map((module) => module[locale]),
  ) as Record<string, string>;
}

export const messages: Record<Locale, Record<string, string>> = {
  "zh-CN": merge("zh-CN"),
  en: merge("en"),
};

export const LOCALES: readonly Locale[] = ["zh-CN", "en"];
export const DEFAULT_LOCALE: Locale = "zh-CN";
