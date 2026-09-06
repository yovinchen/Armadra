import { getTool, setTool } from "./interaction/tool-store";

/**
 * `Esc` 回到选择工具（React Flow 计划 F14）。
 *
 * 这条键**不进** `keybindings.ts`：`Esc` 同时是所有对话框、命令面板、下拉
 * 菜单的关闭键，全局截一次（`useKeybindings` 命中即 `preventDefault` +
 * `stopPropagation`）就会把它们全弄坏。
 *
 * 所以在 `window` 的**冒泡**相位补一个监听器，并且只在这三条都成立时动手：
 *
 *  1. 焦点在画布容器里，或者干脆没有焦点（对话框开着时 Radix 会把焦点
 *     关进去，那时这个监听器什么都不做）；
 *  2. 没有 Radix 菜单开着（先关菜单，不换工具）；
 *  3. 不在文字编辑里（那一下 Esc 是「退出编辑」）。
 *
 * 旧引擎里绕过的那两个 bug（容器监听收不到、`inputs.keys` 卡住）随
 * 旧引擎一起消失了，所以这里比原来短了一半。
 */

const TEXT_ENTRY = 'input, textarea, select, [contenteditable="true"]';

export interface EscapeToSelectOptions {
  /** 画布容器；焦点在它里面才算这一下是给画布的。 */
  container: HTMLElement;
}

export function registerEscapeToSelect({
  container,
}: EscapeToSelectOptions): () => void {
  const owner = container.ownerDocument;

  function belongsToCanvas(): boolean {
    const active = owner.activeElement;
    if (!active || active === owner.body) return true;
    if (!container.contains(active)) return false;
    // 节点体里的输入框（便签、编辑器、终端）自己处理 Esc。
    return !active.closest(TEXT_ENTRY);
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    // Radix 的菜单 / 对话框开着时它自己会关，别抢。
    if (owner.querySelector("[data-radix-popper-content-wrapper]")) return;
    if (!belongsToCanvas()) return;
    if (getTool() !== "select") setTool("select");
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
