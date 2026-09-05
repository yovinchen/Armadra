import * as React from "react";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type {
  TerminalBackendKind,
  TerminalNodeData,
  TerminateMode,
} from "@armadra/shared";

import { runtimeApi, terminalWebSocketUrl, RUNTIME_URL } from "@/api/client";
import { toast } from "sonner";
import {
  FileDragError,
  fileDragMessage,
  hasWorkspaceFileDrag,
  readWorkspaceFileDrag,
  WORKSPACE_FILE_DROP_EVENT,
  type WorkspaceFileDrag,
  type WorkspaceFileDropDetail,
} from "@/files/workspace-drag";
import {
  automaticInputBlocksFileDrop,
  pasteWorkspaceFilePaths,
} from "./file-drop";
import {
  t as translate,
  useT,
  useTerminalPreferences,
  type TerminalPreferences,
} from "@/app/preferences-store";
import { openExternal } from "@/platform";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { useCanvasStore } from "@/store/canvas-store";
import { useAgentStatusStore } from "@/agent/status-store";
import {
  agentLabel,
  agentSessionRequest,
  buildAgentLaunch,
} from "@/agent/launch";
import { isAutoTitled } from "@/meta/auto-title";
import { TERMINAL_PADDING } from "@/nodes/geometry";
import {
  armPendingLaunch,
  disarmPendingLaunch,
  usePendingLaunchWatcher,
  usePendingLaunchStore,
} from "@/agent/pending-launch";
import { isolateTerminalInput } from "./ime";
import {
  appChordsInTerminal,
  isMacPlatform,
  keyDisposition,
  rememberOscTitle,
  shouldApplyOscTitle,
  shouldRefit,
} from "./compat";
import { loadRuntimePlatform, runtimePlatform } from "./platform";
import { SCROLL_THROTTLE_MS, WheelAccumulator, postScroll } from "./scrollback";
import { createTerminalTransport, type TerminalTransport } from "./transport";
import { TerminalInputLog } from "./input-log";
import { useOnScreen, usePageVisible } from "@/panels/resources/use-visibility";
import {
  bufferOffscreenChunk,
  createOffscreenBuffer,
  drainOffscreenBuffer,
  HIDDEN_DETACH_MS,
  OFFSCREEN_FLUSH_MS,
  rendersActively,
  resolveRenderState,
  type TerminalRenderState,
} from "./render-state";
import {
  claimRenderSlot,
  RENDER_PRIORITY_FOCUSED,
  RENDER_PRIORITY_VISIBLE,
} from "./render-budget";

/* ------------------------------- 时序常量 -------------------------------- */

/**
 * Agent 启动时序（计划书 §5.1：启动行是被"敲进 shell"的，不是 exec）。
 *
 * `hello` 之后武装启动器，然后：
 *  - 每收到一段输出就把定时器重置为 QUIET_MS —— 提示符打完就会安静下来；
 *  - 一直没有输出（提示符为空、或 tmux 重绘早于 attach）则在 COLD_MS 时兜底发出；
 *  - `stdinPrompt`（opencode 这类 promptMode=stdin-after-start）再等 PROMPT_MS
 *    发第二次，给 TUI 起来的时间。
 * 整个过程只发生一次，由 `launchPhase` 保证。
 */
const LAUNCH_QUIET_MS = 400;
const LAUNCH_COLD_MS = 3_000;
const LAUNCH_PROMPT_MS = 600;

/** 尺寸去抖（§15.7 / §18.2 规则 2）。 */
const RESIZE_DEBOUNCE_MS = 80;

/** 折叠后延迟 detach，避免"折叠一下又展开"来回重连（§15.7）。 */
const DETACH_GRACE_MS = 5_000;

const TERMINAL_SCROLLBACK = 5_000;

/** 铃声闪一下头部图标的时长（§18.3 铃声行）。 */
export const BELL_FLASH_MS = 600;

/* --------------------------------- 类型 ---------------------------------- */

export type TerminalConnection =
  | "idle"
  | "starting"
  | "connecting"
  | "live"
  | "detached"
  | "exited"
  | "failed";

export interface TerminalSurfaceStatus {
  connection: TerminalConnection;
  exitCode: number | null;
  error: string | null;
  /** Actual PTY identity from the current transport hello; never provider IDs. */
  binding?: { sessionId: string; generation: number } | null;
  /**
   * 视图状态（终端宿主设计 §7.1）。与 `connection` 正交：它只说这个终端此刻
   * 以什么强度渲染，进程的死活仍然只看 `connection`。
   */
  render: TerminalRenderState;
}

/**
 * 表面内部维护的那一半状态。
 *
 * `render` 不在里面：它是从折叠 / 视口 / 窗口前后台 / 焦点 / 渲染名额算出来的
 * 派生值，放进 `patch()` 能改的状态里，迟早会有人用一次连接事件把它覆盖掉。
 */
type ConnectionStatus = Omit<TerminalSurfaceStatus, "render">;

export interface TerminalSurfaceHandle {
  /** 搜索（⌘F 打开的输入框调它）。 */
  find: (query: string, direction?: "next" | "previous") => void;
  clearSearch: () => void;
  focus: () => void;
  /** 三级 terminate（§15.5）。 */
  terminate: (mode: TerminateMode) => void;
  /** 丢弃当前会话并新建一个（重新运行）。 */
  restart: () => void;
  /** 同一 session_key 换新 generation。 */
  recycle: () => void;
  /** 直接写一行到 PTY（重启 Agent、投递消息用）。 */
  writeLine: (line: string) => void;
  /** 右键菜单「复制」。没有选区时是空操作。 */
  copySelection: () => void;
  /** 右键菜单「粘贴」。 */
  paste: () => void;
}

export interface TerminalSurfaceProps {
  nodeId: string;
  data: TerminalNodeData;
  collapsed: boolean;
  onStatusChange?: (status: TerminalSurfaceStatus) => void;
  /** 收到 BEL：头部图标闪一下，**不改变任何尺寸**（§18.2 规则 1）。 */
  onBell?: () => void;
  /** ⌘F：打开头部的搜索 Popover（§18.3 搜索行），不进终端。 */
  onFind?: () => void;
  ref?: React.Ref<TerminalSurfaceHandle>;
}

/* -------------------------------------------------------------------------- */

/**
 * xterm 表面。只做四件事（§15.7）：连接时清屏并等 `hello`；把
 * `snapshot` / `output` 写进 xterm；resize 去抖 80ms；`stale` 或重连时清屏重建。
 *
 * 会话的生命周期（创建 / 复用 / 重建）也在这里，因为它和 `hello` 的时序绑在一起。
 */
function TerminalSurfaceImpl({
  nodeId,
  data,
  collapsed,
  onStatusChange,
  onBell,
  onFind,
  ref,
}: TerminalSurfaceProps) {
  const t = useT();
  /** 外层：由 flex 决定尺寸，`position:relative`，是 ResizeObserver 的观测对象。 */
  const bodyRef = React.useRef<HTMLDivElement>(null);
  /** 内层：`absolute inset-0`，xterm 的 DOM 全在里面，撑不动外层。 */
  const containerRef = React.useRef<HTMLDivElement>(null);
  const terminalRef = React.useRef<Terminal | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const searchRef = React.useRef<SearchAddon | null>(null);
  const transportRef = React.useRef<TerminalTransport | null>(null);
  /**
   * `refit()` 用（§18.2 规则 3）。
   *
   * 从 v4 起它的含义是「**正在全速渲染**」而不只是「没折叠」：设计 §7.1
   * 要求「不能因 `display:none` 仍让几十个终端每帧 fit 和重绘」，滚出视口、
   * 窗口在后台、以及没抢到渲染名额的终端一样不该 fit。
   */
  /**
   * 输入账跟着这个终端走，不跟着 socket 走：重连会换一个 transport，
   * 但「哪几条按键还没落地」这件事必须跨过那次断线（客户端平台设计，移动端重连）。
   */
  const inputLogRef = React.useRef<TerminalInputLog | null>(null);
  inputLogRef.current ??= new TerminalInputLog();
  const visibleRef = React.useRef(false);
  /** 离屏时攒下来的输出；见 `render-state.ts`。 */
  const bufferRef = React.useRef(createOffscreenBuffer());
  /** 是否每帧直接写进 xterm。离屏时改为按 `OFFSCREEN_FLUSH_MS` 批量灌。 */
  const writeThroughRef = React.useRef(false);
  const onBellRef = React.useRef(onBell);
  onBellRef.current = onBell;
  const onFindRef = React.useRef(onFind);
  onFindRef.current = onFind;
  /** `hello` 报的后端；滚轮桥只对 tmux 有意义（§18.5）。 */
  const backendRef = React.useRef<TerminalBackendKind | null>(null);
  /** 滚轮桥要往哪个会话发；`sessionId` 是 state，effect 里读 ref 更省重挂。 */
  const sessionIdRef = React.useRef<string | undefined>(undefined);
  const fileDropQueue = React.useRef<Promise<void>>(Promise.resolve());

  /** 右键菜单打开那一刻有没有选区（决定「复制」是否可点）。 */
  const [hasSelection, setHasSelection] = React.useState(false);

  const preferences = useTerminalPreferences();
  const preferencesRef = React.useRef(preferences);
  preferencesRef.current = preferences;

  /**
   * 节点数据的最新快照。刻意用 ref 而不是让它进依赖数组：`data` 每次
   * `updateNodeData` 都是新对象，一旦进了 `ensureSession` 的依赖，
   * 写回 sessionId 本身就会把"确保会话"重跑一遍。
   */
  const dataRef = React.useRef(data);
  dataRef.current = data;

  /** 本次挂载里由我们创建的会话——只有它才需要敲启动行。 */
  const freshSessionRef = React.useRef(false);
  /** 正在创建会话：StrictMode 的双次 effect 不能开出两个 PTY。 */
  const creatingRef = React.useRef(false);
  const launchPhaseRef = React.useRef<"idle" | "armed" | "sent">("idle");
  const launchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const promptTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const [sessionId, setSessionId] = React.useState<string | undefined>(
    data.sessionId,
  );
  const [attempt, setAttempt] = React.useState(0);
  // 意外断线后的自动重连：1s 起指数退避，上限 10s；收到 hello 即复位
  const reconnectTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const reconnectDelayRef = React.useRef(1000);
  const [detached, setDetached] = React.useState(false);
  const [status, setStatus] = React.useState<ConnectionStatus>({
    connection: "idle",
    exitCode: data.lastExitCode ?? null,
    error: null,
  });

  const statusRef = React.useRef(status);
  statusRef.current = status;
  const patch = React.useCallback((next: Partial<ConnectionStatus>) => {
    // Drop validation may finish before React commits a status event.
    statusRef.current = { ...statusRef.current, ...next };
    setStatus(statusRef.current);
  }, []);

  /* ------------------------------ 视图状态 -------------------------------- */

  /*
   * 三个「有没有人在看」的输入（设计 §7.1）。前两个复用资源徽标那套观测器：
   * 画布不裁剪节点（`canCull() => false`），离屏节点仍然挂在 DOM 上，只有
   * `IntersectionObserver` 说得出它其实在屏幕外。
   */
  const onScreen = useOnScreen(bodyRef);
  const pageVisible = usePageVisible();
  const [focused, setFocused] = React.useState(false);
  const [budgeted, setBudgeted] = React.useState(false);

  const render = resolveRenderState({
    connection: status.connection,
    collapsed,
    onScreen,
    pageVisible,
    focused,
    detached,
    budgeted,
  });
  const active = rendersActively(render);
  visibleRef.current = active;
  writeThroughRef.current = active;

  React.useEffect(() => {
    onStatusChange?.({ ...status, render });
  }, [onStatusChange, status, render]);

  /*
   * 渲染名额（设计 §7.1「WebGL context 设设备预算」）。
   *
   * 优先级变了就重登记一次——`claimRenderSlot` 没有改优先级的接口，重新申请
   * 拿到更大的序号，正好表达「刚被聚焦的这个最该拿名额」。清理里补一次
   * `setBudgeted(false)`：释放不会回调已经删掉的那条登记，不补的话新的一次
   * 申请如果没抢到名额，状态就停在上一轮的 `true` 上。
   */
  const wantsSlot = !collapsed && onScreen && pageVisible && !detached;
  const priority = focused ? RENDER_PRIORITY_FOCUSED : RENDER_PRIORITY_VISIBLE;
  React.useEffect(() => {
    if (!wantsSlot) {
      setBudgeted(false);
      return;
    }
    const release = claimRenderSlot(nodeId, priority, setBudgeted);
    return () => {
      release();
      setBudgeted(false);
    };
  }, [nodeId, wantsSlot, priority]);

  /** 把攒下的输出灌进 xterm。顺序即到达顺序，一个字节都不重排。 */
  const flushOutput = React.useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const text = drainOffscreenBuffer(bufferRef.current);
    if (text) terminal.write(text);
  }, []);

  /*
   * 离屏时按 `OFFSCREEN_FLUSH_MS` 灌一次，重新可见时立刻灌。
   * 攒着的目的只是不每帧重绘，不是丢数据——所以节奏慢，但一定会灌。
   */
  React.useEffect(() => {
    if (active) {
      flushOutput();
      return;
    }
    const timer = setInterval(flushOutput, OFFSCREEN_FLUSH_MS);
    return () => clearInterval(timer);
  }, [active, flushOutput]);

  const pasteDroppedFiles = React.useCallback(
    (drag: WorkspaceFileDrag) => {
      const store = useCanvasStore.getState();
      const workspace = store.workspace;
      const boardId = store.document?.board.id;
      const terminal = terminalRef.current;
      const transport = transportRef.current;
      const session = sessionIdRef.current;
      if (
        !workspace ||
        !boardId ||
        !terminal ||
        !transport ||
        transport.state !== "live" ||
        statusRef.current.connection !== "live" ||
        transport.generation === null ||
        !session
      ) {
        toast.error(translate("fileDrag.destinationChanged"));
        return;
      }
      const inputState = () => {
        const node = useCanvasStore
          .getState()
          .document?.nodes.find((entry) => entry.id === nodeId);
        const agent =
          node?.data.kind === "terminal"
            ? node.data.agent
            : dataRef.current.agent;
        return {
          nodePending: Boolean(agent?.pendingLaunch),
          launchArmed: launchPhaseRef.current === "armed",
          launchTimer: launchTimerRef.current !== null,
          promptTimer: promptTimerRef.current !== null,
          creating: creatingRef.current,
          pendingPhase: usePendingLaunchStore.getState().entries[nodeId]?.phase,
          acknowledged: Boolean(
            agent?.sessionId || useAgentStatusStore.getState().statuses[nodeId],
          ),
        };
      };
      if (automaticInputBlocksFileDrop(inputState())) {
        toast.error(translate("fileDrag.launchPending"));
        return;
      }
      const target = {
        runtimeUrl: RUNTIME_URL,
        workspaceId: workspace.id,
        workspaceRoot: workspace.rootPath,
        sessionId: session,
        generation: transport.generation,
        ssh: Boolean(dataRef.current.ssh),
        agentId: dataRef.current.agent?.id,
      };
      const active = () => {
        const current = useCanvasStore.getState();
        const node = current.document?.nodes.find(
          (entry) => entry.id === nodeId,
        );
        return (
          current.workspace?.id === target.workspaceId &&
          current.workspace.rootPath === target.workspaceRoot &&
          current.document?.board.id === boardId &&
          node?.data.kind === "terminal" &&
          node.data.sessionId === session &&
          !node.data.ssh &&
          node.data.agent?.id === target.agentId &&
          terminalRef.current === terminal &&
          transportRef.current === transport &&
          statusRef.current.connection === "live" &&
          !automaticInputBlocksFileDrop(inputState()) &&
          transport.state === "live" &&
          transport.generation === target.generation &&
          sessionIdRef.current === session
        );
      };
      fileDropQueue.current = fileDropQueue.current
        .catch(() => {})
        .then(() =>
          pasteWorkspaceFilePaths(drag, target, runtimeApi, active, (text) => {
            // A confirmed DAG launch no longer needs its automatic retry. Only settle
            // it after every file/session check succeeds, immediately before pasting.
            const input = inputState();
            if (input.pendingPhase === "sent" && input.acknowledged)
              disarmPendingLaunch(nodeId);
            // xterm adds bracketed-paste framing and onData uses the current WS
            // generation. It does not append Enter or issue an unguarded HTTP write.
            terminal.paste(text);
            terminal.focus();
          }),
        )
        .catch((error: unknown) => {
          toast.error(translate(fileDragMessage(error)));
        });
    },
    [nodeId],
  );

  React.useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const dropped = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        const detail = (event as CustomEvent<WorkspaceFileDropDetail>).detail;
        pasteDroppedFiles(
          readWorkspaceFileDrag({
            getData: () => JSON.stringify(detail?.drag),
          }),
        );
      } catch (error) {
        toast.error(translate(fileDragMessage(error)));
      }
    };
    body.addEventListener(WORKSPACE_FILE_DROP_EVENT, dropped);
    return () => body.removeEventListener(WORKSPACE_FILE_DROP_EVENT, dropped);
  }, [pasteDroppedFiles]);

  /* -------------------------------- fit 守卫 ------------------------------ */

  /**
   * §18.2 规则 2：**唯一**允许调 `fit()` 的地方。
   *
   * 先问 `proposeDimensions()`，只有算出来的整数列/行和当前不一样才动手，
   * 也才发 `resize`。这一条就是「终端一直跳」的解药：`fit()` 会让 tmux
   * 整屏重绘、重绘可能让容器再抖一个亚像素，如果不比较就会无限循环。
   */
  const refit = React.useCallback(() => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit || !visibleRef.current) return;
    let proposed: { cols: number; rows: number } | undefined;
    try {
      proposed = fit.proposeDimensions();
    } catch {
      return;
    }
    if (!shouldRefit(proposed, { cols: terminal.cols, rows: terminal.rows })) {
      return;
    }
    try {
      fit.fit();
    } catch {
      return;
    }
    transportRef.current?.resize(terminal.cols, terminal.rows);
  }, []);

  /* ------------------------------ xterm 实例 ----------------------------- */

  React.useEffect(() => {
    const body = bodyRef.current;
    const container = containerRef.current;
    if (!body || !container) return;

    const terminal = new Terminal({
      allowProposedApi: true,
      scrollback: TERMINAL_SCROLLBACK,
      // 原生滚动条被 CSS 藏掉了（§18.2 规则 1），滚屏靠 tmux 历史；
      // 这里留着 xterm 自己的滚动能力，只是看不见滚动条。
      ...terminalAppearance(preferencesRef.current, container),
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
    terminalRef.current = terminal;
    fitRef.current = fit;

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
          onFindRef.current?.();
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
      transportRef.current?.input(chunk);
    });
    // 选中即复制（设置项，默认关）。`onSelectionChange` 在拖拽过程中会连发，
    // 拿到空选区时不要清掉剪贴板。
    const selection = terminal.onSelectionChange(() => {
      if (!preferencesRef.current.copyOnSelect) return;
      writeClipboard(terminal.getSelection());
    });
    const bell = terminal.onBell(() => onBellRef.current?.());
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
      const sessionId = sessionIdRef.current;
      if (lines !== 0 && sessionId) void postScroll(sessionId, lines);
    };
    const onWheel = (event: WheelEvent) => {
      if (backendRef.current !== "tmux") return;
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
      terminal.dispose();
      /*
       * **不要在这里 `forgetOscTitle(nodeId)`**（2026-09-04 Phase 4 复跑时
       * 发现）：这个清理在热重载、StrictMode 的二次挂载、折叠重建时都会跑，
       * 而节点还在。忘掉之后，节点标题已经被上一轮 OSC 写成了命令名，
       * `shouldApplyOscTitle` 就判成「用户改过名」，这个终端从此不再跟随标题。
       * 记忆按节点 id 存（`terminal/compat.ts`，带上限），节点真的删掉之后
       * 那一条只是块无害的死数据。
       */
      terminalRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [nodeId, refit]);

  /* ------------------------------ 外观偏好 ------------------------------- */

  /**
   * 字体 / 字号 / 行高 / 字距 / 光标 变了：改 options，然后**只 fit 一次**
   * （§18.3 设置项行）。改字号会真的改变字符格子，所以这一次 fit 一定要发。
   */
  React.useEffect(() => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    if (!terminal || !container) return;
    Object.assign(terminal.options, terminalAppearance(preferences, container));
    refit();
  }, [preferences, refit]);

  /* ------------------------------ WebGL（可选） --------------------------- */

  /**
   * §18.2 规则 5：默认 DOM 渲染器（画布 CSS 缩放下文字始终清晰）。
   * WebGL 是设置项，按需异步装；丢上下文就卸掉退回 DOM，不重建终端。
   *
   * 还要看渲染名额（设计 §7.1）：WebGL 上下文是设备级的稀缺资源，浏览器给的
   * 数量有限，超了之后最早的那个会被静默丢掉——表现是某个终端毫无征兆地黑屏。
   * 所以丢名额就卸 addon、拿回名额再装回来；**`Terminal` 实例始终不动**，
   * 「回收只释放渲染资源」，屏幕内容和 PTY 都不受影响。
   */
  React.useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !preferences.webgl || !active) return;
    let addon: { dispose: () => void } | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        if (cancelled) return;
        const instance = new WebglAddon();
        instance.onContextLoss(() => instance.dispose());
        terminal.loadAddon(instance);
        addon = instance;
      } catch {
        // WebGL 不可用（软件渲染、驱动黑名单）：留在 DOM 渲染器上。
      }
    })();
    return () => {
      cancelled = true;
      addon?.dispose();
    };
  }, [preferences.webgl, active]);

  /* ------------------------- 重新可见后补一次 fit ------------------------- */

  React.useEffect(() => {
    if (!active) return;
    // 离屏期间 `refit()` 是空操作（`visibleRef`），而且 `display:none` 时
    // 容器是 0×0，只有回到全速渲染的那一帧才量得出真实尺寸。
    const frame = requestAnimationFrame(refit);
    return () => cancelAnimationFrame(frame);
  }, [active, refit]);

  /* ----------------------------- 会话的建立 ------------------------------ */

  const ensureSession = React.useCallback(
    async (forceNew: boolean) => {
      const store = useCanvasStore.getState();
      const workspace = store.workspace;
      if (!workspace) return;
      const node = store.document?.nodes.find((item) => item.id === nodeId);
      const nodeData =
        node && node.data.kind === "terminal" ? node.data : dataRef.current;

      if (!forceNew && nodeData.sessionId) {
        try {
          const existing = await runtimeApi.getTerminal(nodeData.sessionId);
          if (existing.status === "running") {
            freshSessionRef.current = false;
            setSessionId(existing.id);
            return;
          }
        } catch {
          // 404 / Runtime 重启：往下走，建一个新的
        }
      }

      if (creatingRef.current) return;
      creatingRef.current = true;
      patch({ connection: "starting", error: null });
      try {
        const created = await runtimeApi.createTerminal({
          workspaceId: workspace.id,
          cwd: nodeData.cwd ?? workspace.rootPath,
          args: [],
          nodeId,
          ...(nodeData.shell ? { shell: nodeData.shell } : {}),
          // SSH 终端（§21）：只发主机 id，Runtime 自己从设置里拼 `ssh …`。
          ...(nodeData.ssh ? { ssh: { hostId: nodeData.ssh.hostId } } : {}),
          ...(nodeData.agent
            ? { agent: agentSessionRequest(nodeData.agent) }
            : {}),
        });
        freshSessionRef.current = true;
        launchPhaseRef.current = "idle";
        useCanvasStore.getState().updateNodeData(nodeId, {
          sessionId: created.id,
          lastExitCode: null,
        });
        setSessionId(created.id);
        patch({ connection: "connecting", exitCode: null });
      } catch (cause) {
        patch({
          connection: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        creatingRef.current = false;
      }
    },
    [nodeId, patch],
  );

  React.useEffect(() => {
    void ensureSession(false);
    // `attempt` 递增 = 用户点了「重新运行」
  }, [attempt, ensureSession]);

  /* ------------------------------ 启动行时序 ----------------------------- */

  const clearLaunchTimers = React.useCallback(() => {
    if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
    if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
    launchTimerRef.current = null;
    promptTimerRef.current = null;
  }, []);

  const fireLaunch = React.useCallback(() => {
    launchTimerRef.current = null;
    if (launchPhaseRef.current !== "armed") return;
    const store = useCanvasStore.getState();
    const node = store.document?.nodes.find((item) => item.id === nodeId);
    const nodeData =
      node && node.data.kind === "terminal" ? node.data : dataRef.current;
    const agent = nodeData.agent;
    if (!agent) {
      launchPhaseRef.current = "sent";
      return;
    }
    launchPhaseRef.current = "sent";
    // `--after` 造出来的节点不在这里启动：把启动行交给 `pending-launch`，
    // 由它等依赖都 `done` 之后再敲（§5.8）。提示符已经安静下来了，
    // 所以之后任何时刻发出去都不会被写到半截的提示符里。
    if (agent.pendingLaunch) {
      const pending = agent.pendingLaunch;
      armPendingLaunch(nodeId, pending, (command) => {
        transportRef.current?.input(`${command}\r`);
        freshSessionRef.current = false;
      });
      return;
    }
    try {
      const launch = buildAgentLaunch(agent);
      transportRef.current?.input(`${launch.command}\r`);
      freshSessionRef.current = false;
      store.updateNodeData(nodeId, {
        agent: { ...agent, initialCommand: launch.command },
      });
      if (launch.stdinPrompt) {
        const prompt = launch.stdinPrompt;
        promptTimerRef.current = setTimeout(() => {
          transportRef.current?.input(`${prompt}\r`);
          promptTimerRef.current = null;
        }, LAUNCH_PROMPT_MS);
      }
    } catch (cause) {
      patch({
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [nodeId, patch]);

  const armLaunch = React.useCallback(() => {
    if (launchPhaseRef.current !== "idle") return;
    launchPhaseRef.current = "armed";
    clearLaunchTimers();
    launchTimerRef.current = setTimeout(fireLaunch, LAUNCH_COLD_MS);
  }, [clearLaunchTimers, fireLaunch]);

  const noteOutput = React.useCallback(() => {
    if (launchPhaseRef.current !== "armed") return;
    if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
    launchTimerRef.current = setTimeout(fireLaunch, LAUNCH_QUIET_MS);
  }, [fireLaunch]);

  /* -------------------------------- 连接 --------------------------------- */

  React.useEffect(() => {
    if (!sessionId || detached) return;
    const terminal = terminalRef.current;
    if (!terminal) return;

    let disposed = false;
    // 清屏发生在**连接之前**：tmux 后端不发 snapshot，attach 后的第一波重绘
    // （?1049h、鼠标追踪、DA/OSC 查询）必须原样落到一块干净的屏上；
    // 在 hello 之后再清会把这波重绘抹掉。
    // 上一条连接攒下、还没灌完的字节属于被清掉的那块屏，一起丢。
    drainOffscreenBuffer(bufferRef.current);
    terminal.reset();

    /**
     * 写一段输出。
     *
     * 全速渲染时走原来的直写路径，一个字符都不多绕。离屏时攒起来（设计 §7.1：
     * 「不能因 `display:none` 仍让几十个终端每帧 fit 和重绘」）。缓冲非空时
     * 即使已经回到全速也要先入队再整体灌——PTY 的字节流里半个转义序列都不能
     * 错位，插队会把画面弄坏。
     */
    const writeChunk = (chunk: string) => {
      if (writeThroughRef.current && bufferRef.current.chunks.length === 0) {
        terminal.write(chunk);
        return;
      }
      bufferOffscreenChunk(bufferRef.current, chunk);
      if (writeThroughRef.current) flushOutput();
    };
    const log = inputLogRef.current!;
    const transport = createTerminalTransport(
      terminalWebSocketUrl(sessionId, log.writerId),
      {
        onHello: (hello) => {
          if (disposed) return;
          backendRef.current = hello.backend;
          sessionIdRef.current = hello.sessionId;
          reconnectDelayRef.current = 1000;
          patch({
            connection: hello.alive ? "live" : "exited",
            error: null,
            binding: hello.alive
              ? { sessionId: hello.sessionId, generation: hello.generation }
              : null,
          });
          // attach 后必须至少发一次 resize：后端按 80×24 建的 pty，
          // 之后 `refit()` 只在真的变了才发（§18.2 规则 2）。
          refit();
          transport.resize(terminal.cols, terminal.rows);

          const store = useCanvasStore.getState();
          const node = store.document?.nodes.find((item) => item.id === nodeId);
          const nodeData =
            node && node.data.kind === "terminal" ? node.data : dataRef.current;
          // 只有本次挂载新建的会话、带 agent、且 CLI 还没自报 sessionId 时才敲启动行。
          // 待启动节点是例外：它的启动行本来就还没发过，重连之后仍然要接着等
          // 依赖（否则关掉再打开应用，这条绳子就永远悬着了）。
          if (
            hello.alive &&
            (freshSessionRef.current ||
              Boolean(nodeData.agent?.pendingLaunch)) &&
            nodeData.agent &&
            !nodeData.agent.sessionId
          ) {
            armLaunch();
          }
        },
        onSnapshot: (chunk) => {
          if (!disposed) writeChunk(chunk);
        },
        onOutput: (chunk) => {
          if (disposed) return;
          writeChunk(chunk);
          // 启动行的静默判定看的是「后端有没有在输出」，和渲染快慢无关：
          // 离屏的终端一样要在提示符安静下来之后把启动行敲出去。
          noteOutput();
        },
        onStatus: (state, exitCode) => {
          if (disposed) return;
          if (state === "running") {
            patch({ connection: "live", exitCode: null });
            return;
          }
          patch({
            connection: state === "failed" ? "failed" : "exited",
            exitCode,
            binding: null,
          });
          useCanvasStore.getState().updateNodeData(nodeId, {
            lastExitCode: exitCode,
          });
        },
        onWarning: (message) => {
          if (!disposed) patch({ error: message });
        },
        onStale: () => {
          if (disposed) return;
          patch({ binding: null });
          // 同一个 URL、同一个 session id，只是 generation 变了：
          // 重新走一遍连接分支（它会在连接前清屏）。
          setAttempt((value) => value + 1);
        },
        onClose: () => {
          if (disposed) return;
          const connection = statusRef.current.connection;
          // 进程已退出/失败时的关闭是正常收尾；其余情况（Runtime 重启、网络抖动）
          // 都按意外断线处理：标记 detached 并按退避自动重连，重连会先清屏再 attach。
          if (connection === "exited" || connection === "failed") return;
          patch({ connection: "detached", binding: null });
          const delay = reconnectDelayRef.current;
          reconnectDelayRef.current = Math.min(delay * 2, 10_000);
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            if (!disposed) setAttempt((value) => value + 1);
          }, delay);
        },
      },
      undefined,
      log,
    );
    transportRef.current = transport;
    patch({ connection: "connecting", binding: null });

    return () => {
      disposed = true;
      clearLaunchTimers();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      transport.close();
      if (transportRef.current === transport) transportRef.current = null;
    };
    // 节点数据只经 `dataRef` 读最新值，不进依赖数组：否则改个标题都要重连
  }, [sessionId, detached, attempt, refit, flushOutput]);

  /* ------------------------------ 待启动 DAG ------------------------------ */

  // 依赖状态一变就重算一次门（§5.8）。节点卸载时停掉重试计时器。
  usePendingLaunchWatcher(nodeId, Boolean(data.agent?.pendingLaunch));
  React.useEffect(() => () => disarmPendingLaunch(nodeId), [nodeId]);

  /* ---------------------------- 延迟 detach ------------------------------ */

  /*
   * 两条路都通向「主动关掉 socket」（设计 §7.1 的 detached 行）：
   *
   *  - 折叠 `DETACH_GRACE_MS`（§15.7），宽限是为了不让「折叠一下又展开」来回重连；
   *  - 窗口在后台连续 `HIDDEN_DETACH_MS`。切出去回条消息就掉 socket 只会让人
   *    觉得应用在抖，所以这一条比折叠宽松得多。
   *
   * 进程不受影响：执行端保留 VT/tmux 状态，条件一解除就重新 attach，
   * 走的是原来那条「reset → attach → 快照/重绘」的路，**不会重建会话**。
   */
  React.useEffect(() => {
    const delay = collapsed
      ? DETACH_GRACE_MS
      : pageVisible
        ? null
        : HIDDEN_DETACH_MS;
    if (delay === null) {
      setDetached(false);
      return;
    }
    const timer = setTimeout(() => setDetached(true), delay);
    return () => clearTimeout(timer);
  }, [collapsed, pageVisible]);

  /* ------------------------------ 对外句柄 ------------------------------- */

  React.useImperativeHandle(
    ref,
    () => ({
      find: (query, direction = "next") => {
        if (!query) return;
        // 搜索 addon 到第一次搜索才装（代码分割）；装完立刻执行本次搜索。
        void ensureSearch(terminalRef, searchRef).then((search) => {
          if (!search) return;
          if (direction === "next") search.findNext(query);
          else search.findPrevious(query);
        });
      },
      clearSearch: () => searchRef.current?.clearDecorations(),
      focus: () => terminalRef.current?.focus(),
      terminate: (mode) => {
        const transport = transportRef.current;
        if (transport) {
          transport.terminate(mode);
          return;
        }
        if (sessionId) {
          void runtimeApi.terminateTerminal(sessionId, mode);
        }
      },
      restart: () => {
        freshSessionRef.current = false;
        launchPhaseRef.current = "idle";
        void ensureSession(true);
      },
      recycle: () => {
        if (!sessionId) return;
        void runtimeApi
          .recycleTerminal(sessionId)
          .then(() => setAttempt((value) => value + 1))
          .catch((cause: unknown) => {
            patch({
              error: cause instanceof Error ? cause.message : String(cause),
            });
          });
      },
      writeLine: (line) => transportRef.current?.input(`${line}\r`),
      copySelection: () => writeClipboard(terminalRef.current?.getSelection()),
      paste: () => void pasteIntoTerminal(terminalRef.current),
    }),
    [ensureSession, patch, sessionId],
  );

  /*
   * §18.2 规则 1 的两层结构：
   *   外层 `relative overflow-hidden`，尺寸完全由父级 flex 决定；
   *   内层 `absolute inset-0`，xterm 的 DOM 在里面，撑不动外层。
   * 内边距是常量（4px），不随任何状态变化；`nodrag nowheel` 让滚轮留在
   * 终端里、拖拽不被画布抢走。
   */
  return (
    <ContextMenu
      onOpenChange={(open) =>
        setHasSelection(
          open ? Boolean(terminalRef.current?.hasSelection()) : false,
        )
      }
    >
      <ContextMenuTrigger asChild>
        <div
          ref={bodyRef}
          data-slot="terminal-body"
          // 视图状态放在 DOM 上（设计 §7.1）：性能问题的第一个问题永远是
          // 「它当时以为自己是哪个状态」，而这个答案不该只有 React DevTools
          // 知道。压力脚本与线上排查读的都是这一个属性。
          data-render={render}
          className="nodrag nowheel relative h-full w-full overflow-hidden bg-[var(--term-bg)]"
          onDragOver={(event) => {
            if (
              hasWorkspaceFileDrag(event.dataTransfer) ||
              Array.from(event.dataTransfer.types).includes("Files")
            ) {
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "copy";
            }
          }}
          onDrop={(event) => {
            if (
              !hasWorkspaceFileDrag(event.dataTransfer) &&
              !Array.from(event.dataTransfer.types).includes("Files")
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            try {
              if (!hasWorkspaceFileDrag(event.dataTransfer))
                throw new FileDragError("fileDrag.externalPathUnavailable");
              pasteDroppedFiles(readWorkspaceFileDrag(event.dataTransfer));
            } catch (error) {
              toast.error(translate(fileDragMessage(error)));
            }
          }}
          // 只聚焦，不写任何字节给 PTY（§18.3 鼠标行）。
          onPointerDown={() => terminalRef.current?.focus()}
          // 焦点进了终端（点进来、⌘F 之后跳回来、快捷键聚焦）即视为读过。
          // 同时也是渲染优先级的来源：xterm 6 没有公开的 onFocus/onBlur，
          // 焦点只能从容器的 focusin/focusout 看（§7.1「优先焦点实例」）。
          onFocusCapture={() => {
            setFocused(true);
            const store = useAgentStatusStore.getState();
            if (store.statuses[nodeId]?.unread) store.markRead(nodeId);
          }}
          // 焦点在终端内部挪动（textarea ↔ helper 元素）不算失焦，
          // 否则每次输入法起落都会把渲染优先级抖一遍。
          onBlurCapture={(event) => {
            const next = event.relatedTarget as Node | null;
            if (next && bodyRef.current?.contains(next)) return;
            setFocused(false);
          }}
        >
          <div
            ref={containerRef}
            data-slot="terminal-surface"
            aria-label={t("terminal.label")}
            className="absolute inset-0"
            style={{ padding: TERMINAL_PADDING }}
          />
        </div>
      </ContextMenuTrigger>
      {/* 菜单走 portal，开合不改变 body 尺寸（§18.2 规则 1）。 */}
      <ContextMenuContent className="z-[var(--z-dialog)]">
        <ContextMenuItem
          disabled={!hasSelection}
          onSelect={() => writeClipboard(terminalRef.current?.getSelection())}
        >
          {t("terminal.copy")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => void pasteIntoTerminal(terminalRef.current)}
        >
          {t("terminal.paste")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * §18.2 规则 4：选中、状态胶囊、退出码这些都住在头部，变化时不该把 xterm
 * 重挂一遍。`data` 只在真正改过时才换引用，所以默认的浅比较就够。
 */
export const TerminalSurface = React.memo(TerminalSurfaceImpl);

/* -------------------------------- 辅助函数 -------------------------------- */

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
async function pasteIntoTerminal(terminal: Terminal | null): Promise<void> {
  if (!terminal) return;
  try {
    const text = await navigator.clipboard?.readText();
    if (text) terminal.paste(text);
  } catch {
    // 读剪贴板要权限，拒绝了就什么都不做：⌘V 那条路仍然可用。
  }
}

/** 第一次搜索时才装 SearchAddon。 */
async function ensureSearch(
  terminalRef: React.RefObject<Terminal | null>,
  searchRef: React.RefObject<SearchAddon | null>,
): Promise<SearchAddon | null> {
  if (searchRef.current) return searchRef.current;
  const terminal = terminalRef.current;
  if (!terminal) return null;
  const { SearchAddon } = await import("@xterm/addon-search");
  if (!terminalRef.current) return null;
  const addon = new SearchAddon();
  terminal.loadAddon(addon);
  searchRef.current = addon;
  return addon;
}

/**
 * OSC 0/2 → 节点标题（§18.3 标题行）。用户手动改过名之后就不再覆盖。
 */
function applyOscTitle(nodeId: string, next: string): void {
  const title = next.trim();
  if (!title) return;
  const store = useCanvasStore.getState();
  const node = store.document?.nodes.find((item) => item.id === nodeId);
  if (!node) return;
  const agentId =
    node.data.kind === "terminal" ? node.data.agent?.id : undefined;
  const defaults = [translate("node.terminal"), agentLabel(agentId)];
  // 自动命名写的是「这个会话在做什么」，OSC 写的是「此刻在跑什么命令」。
  // 让后者冲掉前者，标题会跟着每条命令抖动（Agent 自动化设计 §8 的优先级）。
  if (isAutoTitled(nodeId, node.title)) return;
  if (!shouldApplyOscTitle(nodeId, node.title, defaults)) return;
  if (node.title === title) return;
  rememberOscTitle(nodeId, title);
  store.updateNode(nodeId, { title });
}

/** 偏好 → xterm 的外观 options（§18.3 设置项行）。 */
function terminalAppearance(
  preferences: TerminalPreferences,
  element: HTMLElement,
): ITerminalOptions {
  return {
    fontFamily: preferences.fontFamily.trim() || terminalFontFamily(element),
    fontSize: preferences.fontSize,
    lineHeight: preferences.lineHeight,
    letterSpacing: preferences.letterSpacing,
    cursorStyle: preferences.cursorStyle,
    cursorBlink: preferences.cursorBlink,
    macOptionIsMeta: preferences.macOptionIsMeta,
    theme: terminalTheme(element),
  };
}

/* -------------------------------- 主题读取 -------------------------------- */

function cssValue(
  element: HTMLElement,
  name: string,
  fallback: string,
): string {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value || fallback;
}

function terminalFontFamily(element: HTMLElement): string {
  return cssValue(
    element,
    "--font-code",
    "ui-monospace, Menlo, Consolas, monospace",
  );
}

/**
 * 整张调色板都从 token 取（§4.3 规则一：功能代码里不出现字面色值）。
 *
 * `--term-*` 只在 `:root` 声明一次：`--term-bg` 在两套主题下都是深色，
 * ANSI 配色本来就是按深底设计的，跟着浅色主题翻转反而会让 TUI 读不了。
 * 兜底值只在 `getComputedStyle` 拿不到时用（jsdom、样式表还没加载）。
 */
function terminalTheme(element: HTMLElement) {
  const token = (name: string, fallback: string) =>
    cssValue(element, name, fallback);
  const background = token("--term-bg", "#0a0a0a");
  return {
    background,
    foreground: token("--term-fg", "#e6e6e6"),
    cursor: token("--brand", "#0a84ff"),
    cursorAccent: background,
    selectionBackground: token("--term-selection", "#3a5a8c66"),
    black: token("--term-ansi-black", "#151515"),
    red: token("--term-ansi-red", "#ff453a"),
    green: token("--term-ansi-green", "#32d74b"),
    yellow: token("--term-ansi-yellow", "#ffd60a"),
    blue: token("--term-ansi-blue", "#0a84ff"),
    magenta: token("--term-ansi-magenta", "#bf5af2"),
    cyan: token("--term-ansi-cyan", "#6ac4dc"),
    white: token("--term-ansi-white", "#e6e6e6"),
    brightBlack: token("--term-ansi-bright-black", "#6b6b6b"),
    brightRed: token("--term-ansi-bright-red", "#ff6f66"),
    brightGreen: token("--term-ansi-bright-green", "#5ee07a"),
    brightYellow: token("--term-ansi-bright-yellow", "#ffe45e"),
    brightBlue: token("--term-ansi-bright-blue", "#4fa3ff"),
    brightMagenta: token("--term-ansi-bright-magenta", "#d18bf7"),
    brightCyan: token("--term-ansi-bright-cyan", "#8fd8e8"),
    brightWhite: token("--term-ansi-bright-white", "#ffffff"),
  };
}
