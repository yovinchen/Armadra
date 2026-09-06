import { LSPPlugin } from "@codemirror/lsp-client";
import type { Command } from "@codemirror/view";
import { create } from "zustand";

import { t } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { buildEditPreview } from "./edit-preview";
import { useEditPreviewStore } from "./edit-preview-store";
import { peekLanguageClient } from "./client";
import { useDiagnosticsStore } from "./diagnostics-store";
import { languageIdFor } from "./language-ids";
import { pathOfUri } from "./uri";

/**
 * 代码操作（⌘. / 灯泡，语言服务设计 §1.1「代码操作」、§2.6）。
 *
 * `textDocument/codeAction` 一直是通的，但没有入口——server 算出来的修复
 * 没有任何办法被选中。这里补上入口，并且只补入口：选中之后走的仍然是
 * 重命名那条路（预览 → 执行主机按内容版本逐文件写），不新开第二条写盘路径。
 *
 * **带 `command` 的动作不在列表里。** 执行主机在把结果发给浏览器之前就把
 * 它们摘掉了（`language/policy.rs` 的 `code_action_is_offered`），因为应用
 * 它们要靠 `workspace/executeCommand`，而那是设计 §6.2 明确不开放的。这里
 * 不去把它们找回来：一个点了没反应的菜单项比没有这一项更糟。
 */

/** 一条可选的代码操作，界面只认识它的标题与种类。 */
export interface CodeAction {
  title: string;
  /** LSP 的 `kind`，例如 `quickfix`、`refactor.extract`；缺席就不分组。 */
  kind?: string;
  /** 服务器建议优先执行的一条。 */
  preferred?: boolean;
  /** 原样的动作对象，解析与应用时送回去，不在 Web 重新拼。 */
  raw: unknown;
}

interface CodeActionState {
  open: boolean;
  loading: boolean;
  error: string | null;
  actions: CodeAction[];
  /** 触发它的那条会话，应用时要用。 */
  workspaceId: string | null;
  sessionId: string | null;
  /** 触发它的那个视图的 uri，标题里显示。 */
  uri: string | null;
  begin: (context: { workspaceId: string; uri: string }) => void;
  show: (actions: CodeAction[], sessionId: string | null) => void;
  fail: (message: string) => void;
  close: () => void;
}

export const useCodeActionStore = create<CodeActionState>()((set) => ({
  open: false,
  loading: false,
  error: null,
  actions: [],
  workspaceId: null,
  sessionId: null,
  uri: null,
  begin: ({ workspaceId, uri }) =>
    set({
      open: true,
      loading: true,
      error: null,
      actions: [],
      workspaceId,
      uri,
      sessionId: null,
    }),
  show: (actions, sessionId) => set({ actions, sessionId, loading: false }),
  fail: (message) => set({ loading: false, error: message, actions: [] }),
  close: () =>
    set({
      open: false,
      loading: false,
      error: null,
      actions: [],
      workspaceId: null,
      sessionId: null,
      uri: null,
    }),
}));

/* --------------------------------- 请求 ---------------------------------- */

/**
 * ⌘.：问当前选区上有哪些代码操作，把结果放进菜单。
 *
 * 上下文里的 `diagnostics` 是必须带的：大多数 server 的快速修复是按诊断
 * 给的，不带诊断问出来的往往是一张空表。诊断从 store 里取——它存的就是
 * server 推过来的原样对象。
 */
export const showCodeActions: Command = (view) => {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return false;
  if (plugin.client.serverCapabilities?.codeActionProvider === false)
    return false;
  const workspaceId = useCanvasStore.getState().workspace?.id;
  if (!workspaceId) return false;

  const store = useCodeActionStore.getState();
  store.begin({ workspaceId, uri: plugin.uri });
  plugin.client.sync();

  const range = view.state.selection.main;
  const start = plugin.toPosition(range.from);
  const end = plugin.toPosition(range.to);
  void plugin.client
    .request<unknown, unknown[] | null>("textDocument/codeAction", {
      textDocument: { uri: plugin.uri },
      range: { start, end },
      context: { diagnostics: diagnosticsIn(plugin.uri, start.line, end.line) },
    })
    .then((result) => {
      useCodeActionStore
        .getState()
        .show(readActions(result ?? []), sessionOf(plugin.uri));
    })
    .catch((error: unknown) => {
      useCodeActionStore
        .getState()
        .fail(error instanceof Error ? error.message : String(error));
    });
  return true;
};

/** 与选区有交集的诊断，原样送回给 server。 */
function diagnosticsIn(uri: string, from: number, to: number): unknown[] {
  const diagnostics = useDiagnosticsStore.getState().byUri[uri] ?? [];
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.range.start.line <= to && diagnostic.range.end.line >= from,
  );
}

/** `CodeAction | Command` 的数组 → 界面认识的那几个字段。 */
export function readActions(result: unknown[]): CodeAction[] {
  const actions: CodeAction[] = [];
  for (const entry of result) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const title = typeof value.title === "string" ? value.title : "";
    if (!title) continue;
    // 执行主机已经摘过一遍；这一条是同一条规则在客户端的复述，好让一个
    // 老版本的执行主机也不会把点不动的动作摆出来。
    if (value.command !== undefined && value.edit === undefined) continue;
    actions.push({
      title,
      kind: typeof value.kind === "string" ? value.kind : undefined,
      preferred: value.isPreferred === true,
      raw: entry,
    });
  }
  return actions;
}

/**
 * 这个 uri 属于哪条会话。与 `commands.ts` 的 `locate` 同一条推理：画布同一
 * 时刻只开一块工作空间，会话按（工作空间, 语言）注册，所以从路径反推语言
 * 就够了。
 */
function sessionOf(uri: string): string | null {
  const workspaceId = useCanvasStore.getState().workspace?.id;
  const path = pathOfUri(uri);
  const languageId = path ? languageIdFor(path) : null;
  if (!workspaceId || !languageId) return null;
  return peekLanguageClient(workspaceId, languageId)?.status.sessionId ?? null;
}

/* --------------------------------- 应用 ---------------------------------- */

/**
 * 选中一条动作。
 *
 * 动作可能是「懒的」：只有标题和 `data`，正文要再问一次
 * `codeAction/resolve`（写权限门后面）。解析完还是没有 `edit` 的，只能说
 * 明白它做不了，而不是假装做了。
 */
export async function runCodeAction(action: CodeAction): Promise<void> {
  const { workspaceId, sessionId } = useCodeActionStore.getState();
  useCodeActionStore.getState().close();
  if (!workspaceId || !sessionId) return;

  const preview = useEditPreviewStore.getState();
  preview.begin();
  try {
    const resolved = await resolveAction(action);
    const edit = (resolved as Record<string, unknown> | null)?.edit;
    if (!edit) {
      preview.fail(t("lsp.action.noEdit"));
      return;
    }
    preview.show(
      await buildEditPreview({
        workspaceId,
        sessionId,
        title: action.title,
        edit,
      }),
    );
  } catch (error) {
    preview.fail(error instanceof Error ? error.message : String(error));
  }
}

/** 已经带 `edit` 的动作不再问一次；`data` 是懒动作的标记。 */
async function resolveAction(action: CodeAction): Promise<unknown> {
  const value = action.raw as Record<string, unknown> | null;
  if (!value || value.edit !== undefined || value.data === undefined)
    return action.raw;
  const { workspaceId, uri } = useCodeActionStore.getState();
  const path = uri ? pathOfUri(uri) : null;
  const languageId = path ? languageIdFor(path) : null;
  if (!workspaceId || !languageId) return action.raw;
  const client = peekLanguageClient(workspaceId, languageId);
  if (!client?.lsp) return action.raw;
  return client.lsp.request<unknown, unknown>("codeAction/resolve", action.raw);
}
