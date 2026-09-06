import { setDiagnostics } from "@codemirror/lint";
import { ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { LSPPlugin, type LSPClientExtension } from "@codemirror/lsp-client";

import {
  severityOf,
  useDiagnosticsStore,
  type Diagnostic,
} from "./diagnostics-store";

/**
 * `textDocument/publishDiagnostics` 的接收端（语言服务设计 §1.1「诊断」）。
 *
 * 为什么不用 `@codemirror/lsp-client` 自带的 `serverDiagnostics()`：它会把
 * 通知里的 `version` 和它自己给文档的版本号比对，不一致就丢弃。而我们的
 * 版本号来自**执行主机**——影子文档在那边单调递增，一条会话里的两个视图、
 * 一次 server 重启都不会重置它——所以那个比对永远不成立，诊断会被静静丢掉。
 *
 * 这里换成：位置按 `LSPPlugin` 的已同步文档换算、再用未同步的改动映射到当前
 * 缓冲（这一段与官方实现相同），同时把原样的诊断存进 store 供问题面板用。
 * 面板要看没有打开的文件，而 CodeMirror 的 lint 状态只活在一个视图里。
 */
export function armadraDiagnostics(): LSPClientExtension {
  return {
    clientCapabilities: {
      textDocument: { publishDiagnostics: { versionSupport: false } },
    },
    notificationHandlers: {
      "textDocument/publishDiagnostics": (client, params) => {
        const uri = typeof params?.uri === "string" ? params.uri : null;
        if (!uri) return true;
        const diagnostics: Diagnostic[] = Array.isArray(params.diagnostics)
          ? params.diagnostics
          : [];
        useDiagnosticsStore.getState().publish(uri, diagnostics);

        const file = client.workspace.getFile(uri);
        const view = file?.getView();
        const plugin = view ? LSPPlugin.get(view) : null;
        // 没打开这个文件也是正常的：server 会为整个项目报诊断。面板照样收。
        if (!view || !plugin) return true;
        view.dispatch(
          setDiagnostics(
            view.state,
            diagnostics.map((item) => ({
              from: plugin.unsyncedChanges.mapPos(
                plugin.fromPosition(item.range.start, plugin.syncedDoc),
              ),
              to: plugin.unsyncedChanges.mapPos(
                plugin.fromPosition(item.range.end, plugin.syncedDoc),
              ),
              severity: severityOf(item),
              message: item.message,
              source: item.source,
            })),
          ),
        );
        return true;
      },
    },
    editorExtension: autoSync,
  };
}

/**
 * 编辑去抖后把改动推给 server（设计 §2.3「编辑」：150 ms）。
 *
 * 官方包的同名插件用 500 ms。诊断是这个编辑器里最主要的语言能力，半秒的
 * 延迟在打字时看得出来，所以这里按设计写的数字。
 */
export const DID_CHANGE_DEBOUNCE_MS = 150;

const autoSync = ViewPlugin.fromClass(
  class {
    private pending: ReturnType<typeof setTimeout> | null = null;

    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      if (this.pending) clearTimeout(this.pending);
      this.pending = setTimeout(() => {
        this.pending = null;
        LSPPlugin.get(update.view)?.client.sync();
      }, DID_CHANGE_DEBOUNCE_MS);
    }

    destroy() {
      if (this.pending) clearTimeout(this.pending);
    }
  },
);
