import type { KeyCode } from "@xyflow/react";

/**
 * 交给 React Flow 的键位常量（React Flow 计划 F13，归属 canvas）。
 *
 * 全应用只有 `keybindings.ts` 一个键盘监听器。React Flow 自己也装监听器，
 * 所以这里把它能装的都摘掉，只留两个**修饰键**——它们不是命令，而是手势
 * 的一部分，交给 d3-zoom / 选区处理比我们自己合成事件可靠得多：
 *
 *  - `Shift` 多选（点击加选）；
 *  - `Space` 按住拖动平移。
 *
 * `Delete` / `Backspace` 归 `canvas.delete`：删节点要先结束会话并弹确认框，
 * RF 直接删掉就绕过去了。框选不靠 `selectionKeyCode`（那是「按住某键才能
 * 框选」），而是 `selectionOnDrag`——左键在空白处拖就是框选。
 */

export const DELETE_KEY_CODE: KeyCode | null = null;
export const SELECTION_KEY_CODE: KeyCode | null = null;
export const MULTI_SELECTION_KEY_CODE: KeyCode = "Shift";
export const PAN_ACTIVATION_KEY_CODE: KeyCode = "Space";

/** ⌘ / Ctrl + 滚轮缩放（§1.2 F11）。两个键都给，跨平台一份配置。 */
export const ZOOM_ACTIVATION_KEY_CODE: KeyCode = ["Meta", "Control"];

/** 拖动阈值：小于它的位移算点击，不算拖拽（避免点一下就产生一条历史）。 */
export const NODE_DRAG_THRESHOLD = 4;

/** 落点吸附半径（§2.5）：把手附近这么远松手都算连上。 */
export const CONNECTION_RADIUS = 24;
