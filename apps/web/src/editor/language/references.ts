import { LSPPlugin } from "@codemirror/lsp-client";
import type { Command } from "@codemirror/view";

import { runtimeApi } from "@/api/client";
import { useCanvasStore } from "@/store/canvas-store";
import { openFileState } from "./open-files";
import { useReferencesStore, type ReferenceGroup } from "./references-store";
import { isExternalUri, pathOfUri } from "./uri";

/**
 * 「查找引用」（⇧F12），结果进侧栏页而不是编辑器里的浮层。
 *
 * `@codemirror/lsp-client` 自带的 `findReferences` 把结果画在触发它的那个
 * 视图里；点一条跳到别的文件，面板就随着那个视图消失了——而引用列表存在
 * 的意义恰恰是「挨个看过去」。所以这里只负责发请求、分组、取每行正文，
 * 面板本身是 `panels/references/ReferencesPanel.tsx`。
 */

/** LSP `Location` / `LocationLink` 里我们用得上的部分。 */
interface LocationWire {
  uri?: string;
  targetUri?: string;
  range?: { start: { line: number; character: number } };
  targetSelectionRange?: { start: { line: number; character: number } };
  targetRange?: { start: { line: number; character: number } };
}

/**
 * 取正文的文件数上限。
 *
 * 一次「查找引用」在大仓库里可以命中上百个文件，而每个没打开的文件都是一次
 * 读取。超过这个数的分组照常列出来，只是没有那一行的预览——少一行灰字，
 * 好过让面板等上几秒。
 */
const MAX_PREVIEW_FILES = 20;

export const findReferencesInPanel: Command = (view) => {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return false;
  // 能力明确为 false 时不问：一个永远回空列表的面板比没有面板更糟。
  if (plugin.client.serverCapabilities?.referencesProvider === false)
    return false;
  const workspaceId = useCanvasStore.getState().workspace?.id;
  if (!workspaceId) return false;

  const head = view.state.selection.main.head;
  const word = view.state.wordAt(head);
  const store = useReferencesStore.getState();
  store.begin(word ? view.state.sliceDoc(word.from, word.to) : "");
  useCanvasStore.getState().setPanel("references", "drawer");

  // 引用是对着 server 手里那份正文算的，所以先把未发出的改动推过去。
  plugin.client.sync();
  void plugin.client
    .request<unknown, LocationWire[] | null>("textDocument/references", {
      textDocument: { uri: plugin.uri },
      position: plugin.toPosition(head),
      context: { includeDeclaration: true },
    })
    .then(async (locations) => {
      const { groups, external } = groupLocations(locations ?? []);
      await fillPreviews(groups, workspaceId);
      useReferencesStore.getState().show(groups, external);
    })
    .catch((error: unknown) => {
      useReferencesStore
        .getState()
        .fail(error instanceof Error ? error.message : String(error));
    });
  return true;
};

/**
 * 按文件分组，同一文件内按行列排序。
 *
 * 工作空间之外的位置只计数不列出：它们的 uri 是不透明 id，既没有路径也打不
 * 开（设计 §2.2 `uri`）。把它们混进列表只会给出一堆点不动的行。
 */
export function groupLocations(locations: LocationWire[]): {
  groups: ReferenceGroup[];
  external: number;
} {
  const byUri = new Map<string, ReferenceGroup>();
  let external = 0;
  for (const location of locations) {
    const uri = location.uri ?? location.targetUri;
    if (!uri) continue;
    if (isExternalUri(uri)) {
      external += 1;
      continue;
    }
    const path = pathOfUri(uri);
    if (!path) continue;
    const range =
      location.range ??
      location.targetSelectionRange ??
      location.targetRange ??
      undefined;
    const group = byUri.get(uri) ?? { uri, path, locations: [] };
    group.locations.push({
      line: range?.start.line ?? 0,
      character: range?.start.character ?? 0,
    });
    byUri.set(uri, group);
  }
  const groups = [...byUri.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  for (const group of groups) {
    group.locations.sort(
      (left, right) =>
        left.line - right.line || left.character - right.character,
    );
  }
  return { groups, external };
}

/**
 * 给每条引用补上它所在那一行的正文。
 *
 * 已经打开的文件用编辑器缓冲里的正文（那是用户此刻看到的东西），其余从
 * Runtime 读一次。读不到就跳过：面板照常列出位置，只是没有预览。
 */
async function fillPreviews(
  groups: ReferenceGroup[],
  workspaceId: string,
): Promise<void> {
  for (const group of groups.slice(0, MAX_PREVIEW_FILES)) {
    const open = openFileState(group.path);
    let text: string | null = open ? open.read() : null;
    if (text === null) {
      try {
        text = (await runtimeApi.readFile(workspaceId, group.path)).content;
      } catch {
        continue;
      }
    }
    const lines = text.split("\n");
    for (const location of group.locations) {
      const line = lines[location.line];
      if (line === undefined) continue;
      const trimmed = line.trim();
      if (trimmed) location.preview = trimmed.slice(0, 200);
    }
  }
}
