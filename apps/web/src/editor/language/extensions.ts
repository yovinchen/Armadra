import type { Extension } from "@codemirror/state";
import type { Command, KeyBinding } from "@codemirror/view";
import {
  formatKeymap,
  hoverTooltips,
  jumpToDefinitionKeymap,
  serverCompletion,
  signatureHelp,
} from "@codemirror/lsp-client";

import type { LanguageClient } from "./client";
import { showCodeActions } from "./code-actions";
import { renameWithPreview } from "./commands";
import { findReferencesInPanel } from "./references";

/**
 * 一个 `EditorView` 的语言扩展（语言服务设计 §4.2 `extensions.ts`）。
 *
 * 装进 `EditorNode` 的一个新 `Compartment`：会话是异步开起来的，编辑器不能
 * 等它——文件先打开、能编辑，语言能力到货后热插进去，光标和撤销栈都不动。
 * 会话拿不到（`unsupported`）时这里返回空数组，于是**没有补全源**——不出现
 * 一个永远是空的补全列表（设计 §1.1、§6.1 第 1 条）。
 *
 * 键位**不**在这里绑。以前是 `keymap.of([...])` 写死在扩展里，于是设置页
 * 看不见、也改不动；现在五条都登记在 `keybindings/commands.ts` 的 `editor`
 * 作用域下，由 `nodes/editor/use-editor-keys.ts` 按合并后的键位派发到下面这张
 * 表里的实现。三条是我们自己的实现，其余用官方的：
 *
 *  * **重命名**先预览再由执行主机按内容版本写（§2.6）；
 *  * **引用**进侧栏页，因为官方那块面板贴在触发它的视图上，点一条跳到别的
 *    文件时它就跟着消失了；
 *  * **代码操作**官方没有入口，菜单与应用都在 `code-actions.ts`。
 */
export function languageEditorExtensions(
  client: LanguageClient,
  uri: string,
): Extension {
  const plugin = client.plugin(uri);
  if (Array.isArray(plugin) && plugin.length === 0) return [];
  return [plugin, serverCompletion(), hoverTooltips(), signatureHelp()];
}

/**
 * 官方 keymap 里的那个实现。
 *
 * 只取 `run`，不取 `key`：键位现在由用户的键位表决定，库里写的那个默认键
 * 只是这条实现原本挂在哪儿。数组里有多条时依次试，第一个返回 true 的算数
 * ——这也是 CodeMirror 自己对同键多绑的处理方式。
 */
function commandFrom(bindings: readonly KeyBinding[]): Command {
  return (view) => bindings.some((binding) => binding.run?.(view) === true);
}

/**
 * `editor` 作用域里那几条命令的实现。
 *
 * 键位在 `keybindings/commands.ts`，实现在这里，派发在
 * `nodes/editor/use-editor-keys.ts`——三者分开，是为了让「改键」不需要碰
 * 任何一个实现，而「换实现」也不需要碰键位表。
 */
export const LANGUAGE_EDITOR_COMMANDS = {
  "editor.rename": renameWithPreview,
  "editor.format": commandFrom(formatKeymap),
  "editor.goToDefinition": commandFrom(jumpToDefinitionKeymap),
  "editor.findReferences": findReferencesInPanel,
  "editor.codeActions": showCodeActions,
} as const satisfies Record<string, Command>;
