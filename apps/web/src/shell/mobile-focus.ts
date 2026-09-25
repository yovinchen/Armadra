import type { CanvasNodeType } from "@armadra/shared";

/**
 * 哪些节点值得在手机上整屏打开（客户端平台设计，移动端能力矩阵）。
 *
 * 单独一个文件，是为了不把节点头部和焦点页绕成一个环：`NodeShell` 要判断这件
 * 事才能决定画哪个按钮，而焦点页要渲染节点体——两边都从这里拿，谁也不 import
 * 谁。
 */
const FOCUSABLE: ReadonlySet<CanvasNodeType> = new Set<CanvasNodeType>([
  "terminal",
  "editor",
]);

/**
 * 便签、分组与那两张只读卡片在画布上就够看，不进焦点页。
 *
 * 浏览器节点看 core：手机上打开画布的永远是一个浏览器标签页，没有
 * `<webview>`；只有 core 带 headless 浏览器（`headlessBrowser`，见
 * `nodes/browser/availability.ts`）时节点体才是画面流，整屏打开才有东西看。
 */
export function canFocusOnPhone(
  type: CanvasNodeType,
  headlessBrowser = false,
): boolean {
  if (type === "browser") return headlessBrowser;
  return FOCUSABLE.has(type);
}
