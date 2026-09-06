/**
 * 编辑器节点内部的快捷键（`keybindings` 的 `editor` 作用域）。
 *
 * 这五条以前各自为政：⌘S 是 `use-save.ts` 里手写的 `metaKey || ctrlKey`
 * 比对，F2 / F12 / ⇧F12 / ⇧⌥F 写死在 CodeMirror 的 `keymap.of([...])` 里。
 * 结果是设置页看不见它们，用户也改不动，而且两处的「终端优先 / 输入框放行」
 * 规则和应用其它地方并不一致。
 *
 * 现在它们和别的命令一样登记在命令表里，键位走同一套三层合并，只是监听器
 * 装在**这个节点自己的根元素**上而不是 window 上——多开几个编辑器节点时，
 * 只有键盘所在的那个会响应。`when: "editorFocus"` 再挡一道：节点标题栏的
 * 重命名输入框也在这棵子树里，在那儿按 ⌘S 不该保存文件。
 */
import * as React from "react";

import { LANGUAGE_EDITOR_COMMANDS } from "../../editor/language/extensions";
import { useKeybindings, type KeybindingHandlers } from "../../keybindings";
import type { EditorView } from "@codemirror/view";

export interface EditorKeysOptions {
  /** 这个节点的根元素；监听器装在它上面。 */
  root: HTMLElement | null;
  /** 当前的 CodeMirror 视图；还没建好时语言命令什么也不做。 */
  view: EditorView | null;
  save: () => void;
}

export function useEditorKeybindings({
  root,
  view,
  save,
}: EditorKeysOptions): void {
  const viewRef = React.useRef(view);
  viewRef.current = view;

  const handlers = React.useMemo<KeybindingHandlers>(() => {
    const run = (id: keyof typeof LANGUAGE_EDITOR_COMMANDS) => () => {
      const current = viewRef.current;
      // 视图还没建好，或者语言扩展没装上：命令返回 false，什么也不发生。
      // 这仍然算「命中了」，所以键不会漏给下面的 CodeMirror 去做别的事。
      if (current) LANGUAGE_EDITOR_COMMANDS[id](current);
    };
    return {
      "editor.save": save,
      "editor.rename": run("editor.rename"),
      "editor.format": run("editor.format"),
      "editor.goToDefinition": run("editor.goToDefinition"),
      "editor.findReferences": run("editor.findReferences"),
      "editor.codeActions": run("editor.codeActions"),
    };
  }, [save]);

  useKeybindings(handlers, { scopes: ["editor"], target: root });
}
