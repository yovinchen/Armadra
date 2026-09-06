/**
 * 「引用到 Agent」子菜单的插槽（React Flow 计划 §5.1 的 B4/B5 协调条款）。
 *
 * B4 只建这个文件并让 `item-menu.tsx` 无条件渲染它；内容归 B5（内容引用，
 * F29）。在 B5 落地之前它渲染 `null`，白板对象的右键菜单少一项，别的都在。
 *
 * 做成独立文件而不是 `item-menu.tsx` 里的一段注释，是为了两批并行时不撞：
 * B5 只重写这一个文件，`item-menu.tsx` 的层级 / 复制 / 删除那几项不受影响。
 */
export interface ReferenceMenuItemsProps {
  /** 右键作用的白板对象 id（`wb:<uuid>`），已按选区展开。 */
  itemIds: readonly string[];
}

export function ReferenceMenuItems(_props: ReferenceMenuItemsProps) {
  // B5：引用子菜单（选 Agent、64 上限提示、重新同步）。
  return null;
}
