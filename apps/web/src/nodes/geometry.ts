/** Shared by the DOM shell, the canvas projection and document sizing. */
export const NODE_BORDER_WIDTH = 1;
/**
 * 折叠高度 = 头部 + 上下边框，下面不留空带。
 *
 * 2026-09-19：40 → 32（头部 30）。头部只有标题、状态胶囊和两颗图标钮，
 * 40px 里有 10px 是纯空气——那 8px 直接还给内容（契约 §3.4）。
 */
export const COLLAPSED_HEIGHT = 32;
export const HEADER_HEIGHT = COLLAPSED_HEIGHT - NODE_BORDER_WIDTH * 2;
/**
 * 终端四周的内边距。同一批收紧：8 → 4。
 *
 * xterm 的列/行由可用像素整除得出，所以这里省下的每 4px 都会变成真实的
 * 一列或一行（`terminal/surface/use-refit.ts`）。
 */
export const TERMINAL_PADDING = 4;
