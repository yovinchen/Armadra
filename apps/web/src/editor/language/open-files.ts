/**
 * 现在有哪些编辑器节点开着哪些文件，以及它们脏不脏。
 *
 * `WorkspaceEdit` 预览需要这个（语言服务设计 §2.6 第 2 步）：受影响的已打开
 * 文档必须**干净**，否则应用就会把用户的草稿覆盖掉。执行主机侧也会用影子
 * 文本再核对一次（`edits::dirty_files`），这里是为了让对话框在用户点「应用」
 * *之前*就能列出该先保存哪几个文件，而不是拿一个 409 去解释。
 *
 * 登记只在编辑器节点挂载期间存在，不进 store、不进画板：它描述的是当前
 * 这一刻的界面，重开一次画布本来就该重新登记。
 */

export interface OpenFileEntry {
  /** 工作空间相对路径。 */
  path: string;
  /** 有未保存的草稿。 */
  dirty: boolean;
  /** 编辑器读到（或上次保存拿到）的内容版本；非 UTF-8 文件没有。 */
  sha256?: string;
  /** 当前缓冲里的正文，用来算预览 diff。 */
  read: () => string;
}

/** 同一路径可以被多个节点打开；键是节点 id。 */
const entries = new Map<string, OpenFileEntry>();
const listeners = new Set<() => void>();

export function registerOpenFile(nodeId: string, entry: OpenFileEntry): void {
  entries.set(nodeId, entry);
  for (const listener of [...listeners]) listener();
}

export function unregisterOpenFile(nodeId: string): void {
  if (!entries.delete(nodeId)) return;
  for (const listener of [...listeners]) listener();
}

export function onOpenFilesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 这条路径在界面上的状态。多个节点开同一个文件时任意一个脏就算脏——
 * 覆盖哪一个的草稿都是覆盖。
 */
export function openFileState(path: string): OpenFileEntry | null {
  let found: OpenFileEntry | null = null;
  for (const entry of entries.values()) {
    if (entry.path !== path) continue;
    if (entry.dirty) return entry;
    found ??= entry;
  }
  return found;
}

/** 测试用。 */
export function resetOpenFiles(): void {
  entries.clear();
  listeners.clear();
}
