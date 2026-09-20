import { account } from "./account";
import { agent } from "./agent";
import { agentInspect } from "./agent-inspect";
import { automation } from "./automation";
import { browser } from "./browser";
import { canvas } from "./canvas";
import { collab } from "./collab";
import { commands } from "./commands";
import { executionHosts } from "./execution-hosts";
import { errors } from "./errors";
import { explorer } from "./explorer";
import { format } from "./format";
import { meta } from "./meta";
import { launcher } from "./launcher";
import { mobile } from "./mobile";
import { modals } from "./modals";
import { nodes } from "./nodes";
import { sessions } from "./sessions";
import { shell } from "./shell";
import { ssh } from "./ssh";
import { host } from "./host";
import { integration } from "./integration";
import { hostIdentity } from "./host-identity";
import { hostNative } from "./host-native";
import { contextUsage } from "./context-usage";
import { desktop } from "./desktop";
import { gitHunks } from "./git-hunks";
import { handoff } from "./handoff";
import { gitCommit } from "./git-commit";
import { gitMessage } from "./git-message";
import { gitLog } from "./git-log";
import { gitStashes } from "./git-stashes";
import { github } from "./github";
import { gitIntegration } from "./git-integration";
import { gitRepository } from "./git-repository";
import { frameBinding } from "./frame-binding";
import { fileDrag } from "./file-drag";
import { resources } from "./resources";
import { fileWorkflow } from "./file-workflow";
import { languageService } from "./language-service";
import { editorMerge } from "./editor-merge";
import { terminal } from "./terminal";
import { updates } from "./updates";
import { usage } from "./usage";

export type Locale = "zh-CN" | "en";

/**
 * 每个功能区一个扁平命名空间（§13.6）。
 *
 * 两种语言都是一等公民：设置页切「语言」后整棵树立刻重渲染，
 * 所以任何面向用户的串都必须经 `useT()` / `t()` 取，不许写死在组件里。
 * `i18n.test.ts` 会逐模块比对 `zh-CN` 与 `en` 的键集合。
 */
export type MessageModule = Record<Locale, Record<string, string>>;

/**
 * 全部消息模块，按模块名索引。
 *
 * 用记录而不是数组，是为了让 `i18n.test.ts` 报错时说得出是哪个模块
 * ——新加一个 `i18n/<模块>.ts` 只要挂进这里，守卫测试自动覆盖它。
 */
export const MESSAGE_MODULES = {
  shell,
  launcher,
  canvas,
  nodes,
  browser,
  agent,
  "agent-inspect": agentInspect,
  automation,
  account,
  terminal,
  resources,
  sessions,
  ssh,
  "execution-hosts": executionHosts,
  host,
  "host-identity": hostIdentity,
  "host-native": hostNative,
  integration,
  "context-usage": contextUsage,
  "git-repository": gitRepository,
  "frame-binding": frameBinding,
  "git-hunks": gitHunks,
  "git-commit": gitCommit,
  "git-message": gitMessage,
  "git-log": gitLog,
  "git-stashes": gitStashes,
  "git-integration": gitIntegration,
  github,
  handoff,
  "file-drag": fileDrag,
  "file-workflow": fileWorkflow,
  "language-service": languageService,
  "editor-merge": editorMerge,
  explorer,
  mobile,
  modals,
  commands,
  format,
  collab,
  meta,
  updates,
  usage,
  desktop,
  errors,
} satisfies Record<string, MessageModule>;

const modules: MessageModule[] = Object.values(MESSAGE_MODULES);

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

export type TranslateValues = Record<string, string | number>;

/**
 * 纯函数翻译。缺键时依次退回 `zh-CN` 与键名本身——界面上宁可看到键名，
 * 也不要一个空白按钮。
 */
export function translate(
  locale: Locale,
  key: string,
  values: TranslateValues = {},
): string {
  const template = messages[locale][key] ?? messages["zh-CN"][key] ?? key;
  return Object.entries(values).reduce(
    (text, [name, replacement]) =>
      text.replaceAll(`{${name}}`, String(replacement)),
    template,
  );
}
