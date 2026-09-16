import * as React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";

import { t as translate } from "@/app/preferences-store";
import { openExternal } from "@/platform";
import { appChordsInTerminal, isMacPlatform, keyDisposition } from "../compat";
import { isolateTerminalInput } from "../ime";
import { loadRuntimePlatform, runtimePlatform } from "../platform";
import {
  SCROLL_THROTTLE_MS,
  WheelAccumulator,
  postScroll,
} from "../scrollback";
import { terminalAppearance, terminalTheme } from "./appearance";
import { writeClipboard } from "./clipboard";
import { compensateScaledPointer } from "./scaled-pointer";
import { applyOscTitle } from "./title";
import { RESIZE_DEBOUNCE_MS, TERMINAL_SCROLLBACK } from "./constants";
import type { SurfaceRefs } from "./refs";

/**
 * xterm 实例的整个生命周期：创建、addon、键盘策略、尺寸观测、主题跟随与
 * tmux 滚轮桥。只依赖 `nodeId` 与 `refit`，所以标题、状态这些都不会重挂它。
 */
export function useXtermInstance(
  refs: SurfaceRefs,
  options: { nodeId: string; refit: () => void },
): void {
  const { nodeId, refit } = options;

  React.useEffect(() => {
    const body = refs.bodyRef.current;
    const container = refs.containerRef.current;
    if (!body || !container) return;

    const terminal = new Terminal({
      allowProposedApi: true,
      scrollback: TERMINAL_SCROLLBACK,
      // 原生滚动条被 CSS 藏掉了（§18.2 规则 1），滚屏靠 tmux 历史；
      // 这里留着 xterm 自己的滚动能力，只是看不见滚动条。
      ...terminalAppearance(refs.preferencesRef.current, container),
      // OSC 8 超链接：交给系统浏览器，不在 WebView 里打开（§18.3 超链接行）。
      linkHandler: {
        activate: (_event, uri) => void openExternal(uri),
      },
      // Windows 直连时 ConPTY 的重绘语义和 unix pty 不同（§18.3 最后一行）。
      ...(runtimePlatform() === "windows"
        ? { windowsPty: { backend: "conpty" as const } }
        : {}),
    });

    // Unicode 11 必须在 `open()` 之前激活，否则第一屏的 CJK / emoji 宽度
    // 会按 Unicode 6 算，之后再切也不会重排（§18.3 Unicode 行）。
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";

    const fit = new FitAddon();
    terminal.loadAddon(fit);

    terminal.open(container);
    // 画布缩放时选区与鼠标上报的坐标要按缩放比折回（`scaled-pointer.ts`）。
    const restorePointer = compensateScaledPointer(terminal);
    refs.terminalRef.current = terminal;
    refs.fitRef.current = fit;

    // 体积大的 addon 在 `open()` 之后异步装：它们都不影响首屏语义。
    let disposed = false;
    void (async () => {
      const [{ WebLinksAddon }, { ClipboardAddon }] = await Promise.all([
        import("@xterm/addon-web-links"),
        import("@xterm/addon-clipboard"),
      ]);
      if (disposed) return;
      terminal.loadAddon(
        new WebLinksAddon((_event, uri) => void openExternal(uri)),
      );
      // OSC 52：CLI 里 `y` 复制到系统剪贴板走这条路（§18.3 剪贴板行）。
      terminal.loadAddon(new ClipboardAddon());
    })();

    // 输入法：合成事件不能冒泡到画布快捷键，但也不能被取消
    const releaseIme = terminal.textarea
      ? isolateTerminalInput(
          terminal.textarea,
          document.documentElement.lang || "zh-CN",
          translate("terminal.input"),
        )
      : () => undefined;

    /*
     * 键盘策略（§18.3 键盘行）。返回 `false` = 不交给终端。
     * 注册表里 `allowInTerminal` 的那几条归应用（⌘K / ⌘, / ⌘⇧L / ⌘⇧E /
     * ⌘⇧G），窗口的 ⌘W / ⌘Q 留给原生菜单；其余进终端：Ctrl+C/Z/D、方向键、
     * F1–F12、Home/End、Shift+方向 都归 CLI。
     */
    const mac = isMacPlatform();
    const appChords = appChordsInTerminal(undefined, mac);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.isComposing || event.keyCode === 229) return false;
      if (event.type !== "keydown") return true;
      const disposition = keyDisposition(
        event,
        { mac, hasSelection: terminal.hasSelection() },
        appChords,
      );
      if (disposition === "app") {
        // 壳还没接管键盘时（App 尚未挂 `useKeybindings`）⌘F 也要能用：
        // 它是终端自己的搜索，没有别的接管者。
        const primary = mac ? event.metaKey : event.ctrlKey;
        if (primary && !event.shiftKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          refs.onFindRef.current?.();
        }
        return false;
      }
      if (disposition === "copy") {
        writeClipboard(terminal.getSelection());
        event.preventDefault();
        return false;
      }
      // `paste` 交给浏览器的 paste 事件，xterm 自己会按 2004 决定括号粘贴。
      return true;
    });

    /*
     * `onData` only. `onBinary` is deliberately **not** wired: xterm fires it
     * *in addition to* `onData` for mouse reports, so forwarding both makes
     * every click arrive at the CLI twice (measured: one mousedown produced two
     * `\e[<0;8;3M` frames). Its payload is also Latin-1 bytes-in-a-string,
     * which our JSON/UTF-8 transport would re-encode wrongly anyway.
     */
    const input = terminal.onData((chunk) => {
      refs.transportRef.current?.input(chunk);
    });
    // 选中即复制（设置项，默认关）。`onSelectionChange` 在拖拽过程中会连发，
    // 拿到空选区时不要清掉剪贴板。
    const selection = terminal.onSelectionChange(() => {
      if (!refs.preferencesRef.current.copyOnSelect) return;
      writeClipboard(terminal.getSelection());
    });
    const bell = terminal.onBell(() => refs.onBellRef.current?.());
    const title = terminal.onTitleChange((next) => {
      applyOscTitle(nodeId, next);
    });

    /*
     * §18.2 规则 2：ResizeObserver 只观测**外层** body。内层容器是
     * `absolute inset-0`，xterm 在里面画什么都改不了外层尺寸——
     * 这样就没有「fit → 重绘 → 容器变 → 再 fit」的回路可走。
     */
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastBox = { width: 0, height: 0 };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        // 亚像素抖动（画布缩放、字体加载）不算尺寸变化。
        const width = Math.round(entry.contentRect.width);
        const height = Math.round(entry.contentRect.height);
        if (width === lastBox.width && height === lastBox.height) return;
        lastBox = { width, height };
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(refit, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(body);

    // 主题切换时只换调色板，不重建实例（否则整屏内容会没）
    const themeWatcher = new MutationObserver(() => {
      terminal.options.theme = terminalTheme(container);
    });
    themeWatcher.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    /*
     * 滚轮桥（§18.5）。tmux 客户端不在鼠标模式里，滚轮到不了 tmux，所以
     * 我们把它折算成整行发给 Runtime，由它驱动 copy-mode。
     *
     * 三条豁免，缺一不可：
     *  - 直连后端不桥接，xterm 自己就有 scrollback；
     *  - 内层 app 自己开了鼠标追踪（vim / htop）时不桥接，滚轮是它们的输入；
     *  - xterm 自己有回滚内容时不桥接（重绘留下的那些行），先滚它自己的。
     * 其余情况吞掉事件：不 preventDefault 的话 WKWebView 会把它变成
     * 页面回弹（`nowheel` 只挡画布，不挡浏览器自己的滚动）。
     *
     * **必须是捕获相位**（2026-09-04 Phase 4 复跑时发现桥整个失效）：
     * xterm 6 起用的是 vscode 那个 `ScrollableElement`（DOM 里多出一层
     * `.xterm-scrollable-element`），它在自己的 wheel 处理里
     * `stopPropagation()`，冒泡相位的监听器一个事件都收不到。捕获相位挂在
     * `[data-slot="terminal-body"]` 上比它先跑；三条豁免命中时原样放行，
     * xterm 照旧自己处理。
     */
    const accumulator = new WheelAccumulator();
    let pending = 0;
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    const flushScroll = () => {
      scrollTimer = null;
      const lines = pending;
      pending = 0;
      const sessionId = refs.sessionIdRef.current;
      if (lines !== 0 && sessionId) void postScroll(sessionId, lines);
    };
    const onWheel = (event: WheelEvent) => {
      if (refs.backendRef.current !== "tmux") return;
      if (terminal.modes.mouseTrackingMode !== "none") return;
      const viewport = container.querySelector<HTMLElement>(".xterm-viewport");
      if (viewport && viewport.scrollHeight > viewport.clientHeight) return;
      event.preventDefault();
      const lines = accumulator.push(event, terminal.rows);
      if (lines === 0) return;
      pending += lines;
      scrollTimer ??= setTimeout(flushScroll, SCROLL_THROTTLE_MS);
    };
    // `passive: false` —— 不然 preventDefault 会被忽略。
    body.addEventListener("wheel", onWheel, { passive: false, capture: true });

    // 第一次挂载时问一次 Runtime 的平台；答案只影响下一个新建的节点。
    void loadRuntimePlatform();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (scrollTimer) clearTimeout(scrollTimer);
      body.removeEventListener("wheel", onWheel, { capture: true });
      observer.disconnect();
      themeWatcher.disconnect();
      input.dispose();
      selection.dispose();
      bell.dispose();
      title.dispose();
      releaseIme();
      restorePointer();
      terminal.dispose();
      /*
       * **不要在这里 `forgetOscTitle(nodeId)`**（2026-09-04 Phase 4 复跑时
       * 发现）：这个清理在热重载、StrictMode 的二次挂载、折叠重建时都会跑，
       * 而节点还在。忘掉之后，节点标题已经被上一轮 OSC 写成了命令名，
       * `shouldApplyOscTitle` 就判成「用户改过名」，这个终端从此不再跟随标题。
       * 记忆按节点 id 存（`terminal/compat.ts`，带上限），节点真的删掉之后
       * 那一条只是块无害的死数据。
       */
      refs.terminalRef.current = null;
      refs.fitRef.current = null;
      refs.searchRef.current = null;
    };
  }, [refs, nodeId, refit]);
}
