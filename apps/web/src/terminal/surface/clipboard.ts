import type { Terminal } from "@xterm/xterm";

/**
 * 写系统剪贴板（§18.3 剪贴板行）。
 *
 * `navigator.clipboard` 在 WKWebView 里并不总是可用：非安全上下文、或者
 * 调用不在一次用户手势里，都会直接 reject。所以留一条隐藏 textarea +
 * `execCommand("copy")` 的老路兜底 —— 它只在手势里有效，而我们两个调用点
 * （⌘C 的 keydown、右键菜单的 click）都是手势。
 */
export function writeClipboard(text: string | undefined | null): void {
  if (!text) return;
  const fallback = () => {
    const area = document.createElement("textarea");
    area.value = text;
    // 不能 display:none，否则选不中；挪到视口外即可。
    area.setAttribute("aria-hidden", "true");
    area.style.cssText =
      "position:fixed;top:-1000px;left:-1000px;opacity:0;pointer-events:none";
    document.body.append(area);
    area.select();
    try {
      document.execCommand("copy");
    } finally {
      area.remove();
    }
  };
  try {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      fallback();
      return;
    }
    void clipboard.writeText(text).catch(fallback);
  } catch {
    fallback();
  }
}

/** 右键菜单「粘贴」。xterm 的 `paste()` 自己处理括号粘贴。 */
export async function pasteIntoTerminal(
  terminal: Terminal | null,
): Promise<void> {
  if (!terminal) return;
  try {
    const text = await navigator.clipboard?.readText();
    if (text) terminal.paste(text);
  } catch {
    // 读剪贴板要权限，拒绝了就什么都不做：⌘V 那条路仍然可用。
  }
}
