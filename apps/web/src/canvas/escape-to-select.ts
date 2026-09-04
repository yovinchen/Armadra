import type { Editor } from "tldraw";

/**
 * `Esc` 回到选择工具（tldraw 计划 §5 的 Dock 工具组最后一句）。
 *
 * 这条键**不进** `keybindings.ts`：`Esc` 同时是所有对话框、命令面板、下拉
 * 菜单的关闭键，全局截一次（`useKeybindings` 命中即 `preventDefault` +
 * `stopPropagation`）就会把它们全弄坏。
 *
 * tldraw 自己在 `useDocumentEvents` 里监听**容器**上的 `keydown`（不由
 * `kbd` 表控制，所以我们清空 `overrides` 之后它仍在），但实测两处会漏：
 *
 *  1. **焦点不在容器里时收不到。** 点过 Dock 的按钮、关掉一个 Radix 菜单
 *     之后，`document.activeElement` 常常是 `body`，键盘事件根本不经过
 *     `.tl-container`，于是 Esc 没有任何反应。
 *  2. **`inputs.keys` 会卡住。** 容器的 Escape 分支手动往
 *     `editor.inputs.keys` 里塞了一个 `"Escape"`，指望 `keyup` 删掉；而
 *     `keyup` 的处理在 `areShortcutsDisabled()` 为真时直接 return——在文字
 *     shape 里按 Esc 退出编辑正是这种情况（活动元素是 tiptap 的
 *     contenteditable）。那一次的 `"Escape"` 于是永远留在集合里，之后每次
 *     Esc 都被它自己的 `if (inputs.keys.has("Escape"))` 判成「按住不放」。
 *
 * 所以这里在 `window` 的冒泡相位补一个监听器，并且只在「焦点在画布里或者
 * 干脆没有焦点」时动手——对话框打开时 Radix 会把焦点关进去，那时这个监听器
 * 什么都不做。
 */
export function registerEscapeToSelect(editor: Editor): () => void {
  const container = editor.getContainer();

  /** 焦点在画布里（或者压根没有落在任何控件上）才算这一下是给画布的。 */
  function belongsToCanvas(): boolean {
    const active = container.ownerDocument.activeElement;
    if (!active || active === container.ownerDocument.body) return true;
    return container.contains(active);
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (!belongsToCanvas()) return;
    // tldraw 自己的菜单开着时让它处理（先关菜单，不换工具）。
    if (editor.menus.getOpenMenus().length > 0) return;
    // 正在编辑文字：这一下 Esc 是「退出编辑」，不是「换工具」。
    if (editor.getEditingShapeId()) return;
    if (editor.getCurrentToolId() !== "select") editor.setCurrentTool("select");
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    editor.inputs.keys.delete("Escape");
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
}
