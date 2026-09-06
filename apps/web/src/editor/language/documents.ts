import type { ChangeSet, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  LSPPlugin,
  Workspace,
  type LSPClient,
  type WorkspaceFile,
} from "@codemirror/lsp-client";

import { openFileInEditor } from "@/files/open-editor";
import { isExternalUri, pathOfUri } from "./uri";

/**
 * 同一个文件被两个编辑器节点打开时谁说了算（语言服务设计 §2.5）。
 *
 * `@codemirror/lsp-client` 自带的 `DefaultWorkspace` 在第二个视图上直接抛
 * 异常（"doesn't support multiple views on the same file"），而
 * `open-editor.ts` 虽然默认复用已有编辑器，用户仍然可以手动开第二个。
 * 所以这里换成设计写定的规则：
 *
 *  * **第一个打开这个 uri 的视图是拥有者**，只有它的编辑产生 `didChange`。
 *  * 后来的视图是跟随者：诊断、hover、定义照常（都是只读请求，带自己
 *    视图的位置就够），但它的草稿不进 LSP——草稿本来也不在两个节点之间共享。
 *  * 拥有者关掉时所有权转给**最早的**跟随者，并立刻发一次全文 `didChange`：
 *    新拥有者的增量是相对它自己的缓冲算的，不能让 server 停在旧缓冲上。
 *
 * Runtime 侧也有一份同名规则，但那是按*会话*分的；一个工作空间一种语言
 * 只有一条会话，两个节点在 Runtime 眼里是同一个会话，所以视图之间的归属
 * 只能在这里判。
 */

/** 一个 uri 当前的归属，供状态栏显示「跟随另一节点」。 */
export type Ownership = "owner" | "follower";

export interface OwnershipListener {
  (uri: string, view: EditorView, ownership: Ownership): void;
}

class OpenDocument implements WorkspaceFile {
  /** 打开这个 uri 的视图，按打开顺序；`views[0]` 是拥有者。 */
  views: EditorView[] = [];

  constructor(
    readonly uri: string,
    readonly languageId: string,
    public version: number,
    public doc: Text,
  ) {}

  /**
   * 优先给调用方指名的那个视图（它就是提问的那个），否则给拥有者。
   * 服务器主动的编辑只应用到拥有者：跟随者的草稿不属于 LSP。
   */
  getView(main?: EditorView): EditorView | null {
    if (main && this.views.includes(main)) return main;
    return this.views[0] ?? null;
  }

  get owner(): EditorView | null {
    return this.views[0] ?? null;
  }
}

export class ArmadraWorkspace extends Workspace {
  files: OpenDocument[] = [];
  private versions = new Map<string, number>();
  private listeners = new Set<OwnershipListener>();

  constructor(client: LSPClient) {
    super(client);
  }

  /** 订阅归属变化；状态栏据此显示「拥有」还是「跟随」。 */
  onOwnership(listener: OwnershipListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private announce(uri: string, view: EditorView, ownership: Ownership): void {
    for (const listener of [...this.listeners]) listener(uri, view, ownership);
  }

  private nextVersion(uri: string): number {
    const next = (this.versions.get(uri) ?? -1) + 1;
    this.versions.set(uri, next);
    return next;
  }

  /** 这个视图是不是它那个 uri 的拥有者。 */
  ownershipOf(view: EditorView): Ownership | null {
    const file = this.files.find((entry) => entry.views.includes(view));
    if (!file) return null;
    return file.owner === view ? "owner" : "follower";
  }

  override openFile(uri: string, languageId: string, view: EditorView): void {
    const existing = this.getFile(uri) as OpenDocument | null;
    if (existing) {
      if (!existing.views.includes(view)) existing.views.push(view);
      this.announce(uri, view, "follower");
      return;
    }
    const file = new OpenDocument(
      uri,
      languageId,
      this.nextVersion(uri),
      view.state.doc,
    );
    file.views.push(view);
    this.files.push(file);
    this.announce(uri, view, "owner");
    this.client.didOpen(file);
  }

  override closeFile(uri: string, view: EditorView): void {
    const file = this.getFile(uri) as OpenDocument | null;
    if (!file) return;
    const wasOwner = file.owner === view;
    file.views = file.views.filter((entry) => entry !== view);
    const next = file.views[0];
    if (next) {
      if (!wasOwner) return;
      // 所有权转移。server 手里还是旧拥有者的缓冲，新拥有者的下一个增量是
      // 按它自己的缓冲算的，所以先把全文推过去对齐。
      file.doc = next.state.doc;
      file.version = this.nextVersion(uri);
      LSPPlugin.get(next)?.clear();
      this.client.notification("textDocument/didChange", {
        textDocument: { uri, version: file.version },
        contentChanges: [{ text: file.doc.toString() }],
      });
      this.announce(uri, next, "owner");
      return;
    }
    this.files = this.files.filter((entry) => entry !== file);
    this.client.didClose(uri);
  }

  /**
   * 只有拥有者的改动上报。跟随者的 `unsyncedChanges` 仍然清掉——它们哪儿
   * 也不去，留着只是让一个长期开着的第二视图慢慢攒内存。
   */
  override syncFiles() {
    const updates: {
      file: WorkspaceFile;
      prevDoc: Text;
      changes: ChangeSet;
    }[] = [];
    for (const file of this.files) {
      for (const [index, view] of file.views.entries()) {
        const plugin = LSPPlugin.get(view);
        if (!plugin) continue;
        if (index > 0) {
          plugin.clear();
          continue;
        }
        const changes = plugin.unsyncedChanges;
        if (changes.empty) continue;
        updates.push({ changes, file, prevDoc: file.doc });
        file.doc = view.state.doc;
        file.version = this.nextVersion(file.uri);
        plugin.clear();
      }
    }
    return updates;
  }

  /**
   * 服务器让我们把另一个文件放到用户面前（跳转到定义等）。
   *
   * 工作空间之外的位置不打开：那条 uri 不带路径，也不该带（§2.2 `uri`）。
   * 文件还没有编辑器节点时新建一个，但视图要等节点挂载完才存在，所以这里
   * 只能返回已经打开的那个——首次跳转会开出节点、第二次才滚过去，这比
   * 假装打开成功要诚实。
   */
  override async displayFile(uri: string): Promise<EditorView | null> {
    if (isExternalUri(uri)) return null;
    const existing = this.getFile(uri) as OpenDocument | null;
    if (existing?.owner) return existing.owner;
    const path = pathOfUri(uri);
    if (!path) return null;
    openFileInEditor(path);
    return null;
  }
}
