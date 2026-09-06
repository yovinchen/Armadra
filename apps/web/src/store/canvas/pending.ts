import type { EntityPatch } from "./history";

/**
 * 「自上一次落盘以来，这个窗口动过哪些实体」（React Flow 计划 §6.3 A04）。
 *
 * 合并远端文档时要回答的问题是「这一条该听谁的」。只看 `saveState` 是不够
 * 的：本地脏的时候整份都以本地为准，等于把另一个窗口这段时间的改动全部
 * 盖掉——两边同时改**不同**的节点就会互相吃掉对方，而这正是 A04 要的反例。
 *
 * 所以记一份被动过的 id：本地改过的那几条以本地为准，其余照收远端的。
 * `store/canvas/internal.commit`、`view.setWhiteboard` 与撤销回放
 * （`history.applyPatch`）三个写入口各自登记，保存收敛之后清空。
 *
 * 一个集合装四张表的 id：节点、连线、白板对象（裸 uuid）与引用行都是 uuid，
 * 不会撞。模块级变量而不是 store 字段——它不该跟着文档存盘，也不该让 45 个
 * store 消费方因为它变了而重渲。
 */

let touched = new Set<string>();

export function markLocalEdits(ids: Iterable<string>): void {
  for (const id of ids) touched.add(id);
}

/** 一条历史补丁碰过的全部实体。撤销 / 重做也是本地编辑，一样要登记。 */
export function markPatch(patch: EntityPatch): void {
  markLocalEdits(patch.nodes.keys());
  markLocalEdits(patch.edges.keys());
  markLocalEdits(patch.items.keys());
  markLocalEdits(patch.references.keys());
}

export function localEdits(): ReadonlySet<string> {
  return touched;
}

/** 落盘收敛、换板、换工作空间：这一轮的账结清了。 */
export function clearLocalEdits(): void {
  if (touched.size === 0) return;
  touched = new Set();
}
