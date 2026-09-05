/**
 * 「打开到行」的转发通道（E01/M4）。
 *
 * 项目搜索点一条命中要做两件事：把文件开出来，然后滚到那一行。这两件事
 * 之间隔着一次挂载，所以行号先存进这里：
 *
 *  * 已经开着的编辑器立刻收到通知；
 *  * 刚 `addNode` 出来的编辑器挂载后自己来取。
 *
 * 取走即清除，一次请求只生效一次——否则同一个节点每次重载文件都会莫名
 * 其妙跳回上一次搜索的位置。
 */

const pending = new Map<string, number>();
type Listener = (path: string, line: number) => void;
const listeners = new Set<Listener>();

/** 请求把 `path` 滚动到第 `line` 行（1 起）。 */
export function revealInEditor(path: string, line: number): void {
  pending.set(path, line);
  for (const listener of [...listeners]) listener(path, line);
}

/** 取走并清除 `path` 的待处理行号。 */
export function takePendingReveal(path: string): number | undefined {
  const line = pending.get(path);
  pending.delete(path);
  return line;
}

export function onEditorReveal(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
