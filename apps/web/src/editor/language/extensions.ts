import type { Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import {
  findReferencesKeymap,
  formatKeymap,
  hoverTooltips,
  jumpToDefinitionKeymap,
  serverCompletion,
  signatureHelp,
} from "@codemirror/lsp-client";

import type { LanguageClient } from "./client";
import { renameWithPreview } from "./commands";

/**
 * 一个 `EditorView` 的语言扩展（语言服务设计 §4.2 `extensions.ts`）。
 *
 * 装进 `EditorNode` 的一个新 `Compartment`：会话是异步开起来的，编辑器不能
 * 等它——文件先打开、能编辑，语言能力到货后热插进去，光标和撤销栈都不动。
 * 会话拿不到（`unsupported`）时这里返回空数组，于是**没有补全源**——不出现
 * 一个永远是空的补全列表（设计 §1.1、§6.1 第 1 条）。
 *
 * 键位按设计 §4.2：F2 重命名、F12 定义、⇧F12 引用、⇧⌥F 格式化。重命名换成
 * 我们自己的实现（先预览再由执行主机写），其余用官方的。
 */
export function languageEditorExtensions(
  client: LanguageClient,
  uri: string,
): Extension {
  const plugin = client.plugin(uri);
  if (Array.isArray(plugin) && plugin.length === 0) return [];
  return [
    plugin,
    serverCompletion(),
    hoverTooltips(),
    signatureHelp(),
    keymap.of([
      { key: "F2", run: renameWithPreview, preventDefault: true },
      ...formatKeymap,
      ...jumpToDefinitionKeymap,
      ...findReferencesKeymap,
    ]),
  ];
}
