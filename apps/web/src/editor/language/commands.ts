import {
  getDialog,
  showDialog,
  type Command,
  type EditorView,
} from "@codemirror/view";
import { getIndentUnit, indentUnit } from "@codemirror/language";
import { LSPPlugin } from "@codemirror/lsp-client";

import { t } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { buildEditPreview } from "./edit-preview";
import { useEditPreviewStore } from "./edit-preview-store";
import { peekLanguageClient } from "./client";
import { languageIdFor } from "./language-ids";
import { pathOfUri } from "./uri";

/**
 * 编辑器里的语言命令（语言服务设计 §1.1、§2.6）。
 *
 * 补全、hover、签名帮助、定义、引用都直接用 `@codemirror/lsp-client` 的实现。
 * 这里只写两个它给的版本不合适的：
 *
 *  * **重命名**：官方实现拿到 `WorkspaceEdit` 就往各个视图上贴，跨文件的
 *    部分只作用于*恰好开着*的那些编辑器，没开的文件悄悄不改。设计要的是
 *    先预览、再由执行主机按内容版本逐文件写（§2.6），所以换成自己的。
 *  * **格式化**：官方的 `formatDocument` 是即发即忘的命令，而保存时格式化
 *    需要知道「改完了没有」才能接着写盘（§2.3「保存」）。
 */

/** 保存时格式化的预算（设计 §2.3）：超时就跳过，不拖着保存。 */
export const FORMAT_ON_SAVE_TIMEOUT_MS = 3_000;

/* -------------------------------- 重命名 --------------------------------- */

/**
 * F2：问新名字，向 server 要 `WorkspaceEdit`，交给预览对话框。
 *
 * 输入框用 CodeMirror 自己的 `showDialog`（与官方实现同一个面板），这样
 * 焦点、Esc 关闭、只读判断都和编辑器其它面板一致，不用再造一个浮层。
 */
export const renameWithPreview: Command = (view) => {
  const plugin = LSPPlugin.get(view);
  const word = view.state.wordAt(view.state.selection.main.head);
  if (!plugin || !word) return false;
  if (plugin.client.serverCapabilities?.renameProvider === undefined) {
    // `undefined` 只在还没 initialize 完时出现；能力明确为 false 也不提供。
    if (plugin.client.serverCapabilities) return false;
  }
  const current = view.state.sliceDoc(word.from, word.to);
  const existing = getDialog(view, "cm-lsp-rename-panel");
  if (existing) {
    const input = existing.dom.querySelector<HTMLInputElement>("[name=name]");
    if (input) {
      input.value = current;
      input.select();
    }
    return true;
  }
  const { close, result } = showDialog(view, {
    label: t("lsp.rename.prompt"),
    input: { name: "name", value: current },
    focus: true,
    submitLabel: t("lsp.rename.submit"),
    class: "cm-lsp-rename-panel",
  });
  void result.then((form) => {
    view.dispatch({ effects: close });
    if (!form) return;
    const input = form.elements.namedItem("name");
    const next = input instanceof HTMLInputElement ? input.value.trim() : "";
    if (!next || next === current) return;
    void requestRename(view, word.from, current, next);
  });
  return true;
};

async function requestRename(
  view: EditorView,
  position: number,
  from: string,
  to: string,
): Promise<void> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return;
  const found = locate(plugin.uri);
  if (!found) return;
  const store = useEditPreviewStore.getState();
  store.begin();
  // 先把未发出的改动推给 server：重命名是对着 server 手里那份正文算的。
  plugin.client.sync();
  try {
    const edit = await plugin.client.request<unknown, unknown>(
      "textDocument/rename",
      {
        newName: to,
        position: plugin.toPosition(position),
        textDocument: { uri: plugin.uri },
      },
    );
    if (!edit) {
      store.fail(t("lsp.rename.empty"));
      return;
    }
    const preview = await buildEditPreview({
      workspaceId: found.workspaceId,
      sessionId: found.sessionId,
      title: t("lsp.rename.title", { from, to }),
      edit,
    });
    store.show(preview);
  } catch (error) {
    store.fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 这个视图的 uri 属于哪条会话。
 *
 * `LSPPlugin` 只知道 uri。会话按（工作空间, 语言）注册，而画布同一时刻只
 * 打开一块工作空间——所以从 uri 里的相对路径反推语言，再去注册表里取会话，
 * 比让每个命令都背一份上下文简单，也不会有第二份真相。
 */
function locate(
  uri: string,
): { workspaceId: string; sessionId: string } | null {
  const workspaceId = useCanvasStore.getState().workspace?.id;
  const path = pathOfUri(uri);
  const languageId = path ? languageIdFor(path) : null;
  if (!workspaceId || !languageId) return null;
  const client = peekLanguageClient(workspaceId, languageId);
  if (!client?.status.sessionId) return null;
  return { workspaceId, sessionId: client.status.sessionId };
}

/* -------------------------------- 格式化 --------------------------------- */

/**
 * 格式化当前文档并等它落到草稿上。
 *
 * 只改缓冲，不写盘——写盘仍然是保存那条路，带内容版本。超时（默认 3 s）
 * 就放弃这一次格式化，让保存照常进行：一次格式化不该挡住保存。
 *
 * 返回是否真的改了东西，`false` 包括「server 说不用改」和「超时」。
 */
export async function formatDocumentAndWait(
  view: EditorView,
  timeoutMs = FORMAT_ON_SAVE_TIMEOUT_MS,
): Promise<boolean> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return false;
  if (plugin.client.serverCapabilities?.documentFormattingProvider === false)
    return false;
  plugin.client.sync();
  const request = plugin.client.request<unknown, TextEditWire[] | null>(
    "textDocument/formatting",
    {
      options: {
        tabSize: getIndentUnit(view.state),
        insertSpaces: view.state.facet(indentUnit).indexOf("\t") < 0,
      },
      textDocument: { uri: plugin.uri },
    },
  );
  const edits = await Promise.race([
    request.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  if (!edits || edits.length === 0) return false;
  // 位置是对着请求发出那一刻的文档算的。这段时间里用户可能又打了字，所以
  // 交给 CodeMirror 自己的映射；碰到被改过的区间就整体放弃，宁可不格式化，
  // 也不要把编辑打散。
  const doc = view.state.doc;
  const changes = edits.map((edit) => ({
    from: offsetOf(doc, edit.range.start),
    to: offsetOf(doc, edit.range.end),
    insert: edit.newText,
  }));
  view.dispatch({ changes, userEvent: "format" });
  return true;
}

interface TextEditWire {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}

function offsetOf(
  doc: EditorView["state"]["doc"],
  position: { line: number; character: number },
): number {
  const line = doc.line(Math.min(Math.max(position.line + 1, 1), doc.lines));
  return Math.min(line.from + Math.max(position.character, 0), line.to);
}
