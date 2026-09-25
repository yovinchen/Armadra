import * as React from "react";
import { toast } from "sonner";
// xterm 的样式跟着它的 JS 走，不放应用入口。
//
// 入口里那一行 `import "@xterm/xterm/css/xterm.css"` 看着只是一个 CSS，但它
// 把 `@xterm/xterm` 这个包名带进了入口的静态图，于是 `vite.config.ts` 的
// `xterm` 分组整块被写进 index.html 的 modulepreload——空画布上没有任何终端，
// 浏览器照样取回并解析 443 kB。挪到这里之后，它和 `use-xterm` 在同一个懒加载
// chunk 里，第一个终端出现时才一起到。
import "@xterm/xterm/css/xterm.css";

import {
  t as translate,
  useT,
  useTerminalPreferences,
} from "@/app/preferences-store";
import { useAgentStatusStore } from "@/agent/status-store";
import {
  disarmPendingLaunch,
  usePendingLaunchWatcher,
} from "@/agent/pending-launch";
import {
  FileDragError,
  fileDragMessage,
  hasWorkspaceFileDrag,
  readWorkspaceFileDrag,
} from "@/files/workspace-drag";
import { TERMINAL_PADDING } from "@/nodes/geometry";
import { Button } from "@/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { loseWebglContexts } from "./render-budget";
import { HIDDEN_DETACH_MS } from "./render-state";
import { terminalAppearance } from "./surface/appearance";
import { pasteIntoTerminal, writeClipboard } from "./surface/clipboard";
import { DETACH_GRACE_MS } from "./surface/constants";
import { useSurfaceRefs } from "./surface/refs";
import { useFileDropPaste } from "./surface/use-file-drop";
import { useSurfaceHandle } from "./surface/use-handle";
import { useLaunchSequence } from "./surface/use-launch";
import { useRefit } from "./surface/use-refit";
import { useRenderBudget } from "./surface/use-render-budget";
import { useHibernation } from "./surface/use-hibernation";
import { useAdoptedSession, useTerminalSession } from "./surface/use-session";
import { useTerminalTransport } from "./surface/use-transport";
import { useXtermInstance } from "./surface/use-xterm";
import type { ConnectionStatus, TerminalSurfaceProps } from "./surface/types";

export { BELL_FLASH_MS } from "./surface/constants";
export { writeClipboard } from "./surface/clipboard";
export type {
  TerminalConnection,
  TerminalSurfaceHandle,
  TerminalSurfaceProps,
  TerminalSurfaceStatus,
} from "./surface/types";

/* -------------------------------------------------------------------------- */

/**
 * xterm 表面。只做四件事（§15.7）：连接时清屏并等 `hello`；把
 * `snapshot` / `output` 写进 xterm；resize 去抖 80ms；`stale` 或重连时清屏重建。
 *
 * 会话的生命周期（创建 / 复用 / 重建）也在这里，因为它和 `hello` 的时序绑在一起。
 *
 * 这个组件只做装配：引用组在 `surface/refs.ts`，其余每一段都是 `surface/`
 * 里的一个 hook —— 渲染预算、拖放粘贴、xterm 实例、会话、启动行、传输、句柄。
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

  /** 右键菜单打开那一刻有没有选区（决定「复制」是否可点）。 */
  const [hasSelection, setHasSelection] = React.useState(false);

  const preferences = useTerminalPreferences();

  const [sessionId, setSessionId] = React.useState<string | undefined>(
    data.sessionId,
  );
  const [attempt, setAttempt] = React.useState(0);
  const [detached, setDetached] = React.useState(false);
  const [status, setStatus] = React.useState<ConnectionStatus>({
    connection: "idle",
    exitCode: data.lastExitCode ?? null,
    error: null,
  });

  const refs = useSurfaceRefs({
    data,
    preferences,
    status,
    onBell,
    onFind,
  });

  const patch = React.useCallback(
    (next: Partial<ConnectionStatus>) => {
      // Drop validation may finish before React commits a status event.
      refs.statusRef.current = { ...refs.statusRef.current, ...next };
      setStatus(refs.statusRef.current);
    },
    [refs],
  );

  /* ------------------------------ 视图状态 -------------------------------- */

  const {
    render,
    active,
    budgeted,
    setFocused,
    pageVisible,
    flushOutput,
    reportContextLoss,
  } = useRenderBudget(refs, {
    nodeId,
    collapsed,
    detached,
    connection: status.connection,
  });
  refs.visibleRef.current = active;
  refs.writeThroughRef.current = active;

  React.useEffect(() => {
    onStatusChange?.({ ...status, render });
  }, [onStatusChange, status, render]);

  const pasteDroppedFiles = useFileDropPaste(refs, nodeId);

  /* -------------------------------- fit 守卫 ------------------------------ */

  const refit = useRefit(refs);

  /* ------------------------------ xterm 实例 ----------------------------- */

  useXtermInstance(refs, { nodeId, refit });

  /* ------------------------------ 外观偏好 ------------------------------- */

  /**
   * 字体 / 字号 / 行高 / 字距 / 光标 变了：改 options，然后**只 fit 一次**
   * （§18.3 设置项行）。改字号会真的改变字符格子，所以这一次 fit 一定要发。
   */
  React.useEffect(() => {
    const terminal = refs.terminalRef.current;
    const container = refs.containerRef.current;
    if (!terminal || !container) return;
    Object.assign(terminal.options, terminalAppearance(preferences, container));
    refit();
  }, [refs, preferences, refit]);

  /* ------------------------------ WebGL（可选） --------------------------- */

  /**
   * §18.2 规则 5：默认 DOM 渲染器（画布 CSS 缩放下文字始终清晰）。
   * WebGL 是设置项，按需异步装；丢上下文就卸掉退回 DOM，不重建终端。
   *
   * addon 的挂载条件是**渲染名额**（设计 §7.1），不是 `active`：WebGL 上下文是
   * 设备级的稀缺资源，浏览器给的数量有限，超了之后它会强制驱逐一个——表现是
   * 某个终端毫无征兆地黑屏或画成 "lost context" 占位。名额由模块级协调器统一
   * 发（`render-budget.ts`），离屏的持有者**继续暖着**，这样平移回来不用重建
   * 渲染器；`active` 只管写穿与 fit，两件事分开。**`Terminal` 实例始终不动**，
   * 「回收只释放渲染资源」，屏幕内容和 PTY 都不受影响。
   *
   * 丢上下文（休眠唤醒、GPU 进程重启）时除了卸 addon，还要**上报**：可见性一点
   * 没变，没有这一声协调器不会知道，终端就无限期停在 DOM 渲染器上。
   */
  React.useEffect(() => {
    const terminal = refs.terminalRef.current;
    if (!terminal || !preferences.webgl || !budgeted) return;
    let addon: { dispose: () => void } | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        if (cancelled) return;
        const instance = new WebglAddon();
        instance.onContextLoss(() => {
          instance.dispose();
          reportContextLoss();
        });
        terminal.loadAddon(instance);
        addon = instance;
      } catch {
        // WebGL 不可用（软件渲染、驱动黑名单）：留在 DOM 渲染器上。
      }
    })();
    return () => {
      cancelled = true;
      if (!addon) return;
      // canvas 必须在 dispose **之前**抓：dispose 会把它们从 DOM 上摘掉。
      const canvases = refs.containerRef.current?.querySelectorAll("canvas");
      const held = canvases ? Array.from(canvases) : [];
      // 这一句就是「字距散开」的源头：它跑在 cleanup 里，元素已被 React 摘掉，
      // 新的 DOM 渲染器按 0 宽推字距。治它的门在 `useRefit`（`dom-spacing.ts`）。
      addon.dispose();
      // dispose 既不 GC 也不弄丢上下文，不补这一刀就会留下占着名额的僵尸。
      loseWebglContexts(held);
    };
  }, [refs, preferences.webgl, budgeted, reportContextLoss]);

  /* ------------------------- 重新可见后补一次 fit ------------------------- */

  React.useEffect(() => {
    if (!active) return;
    // 离屏期间 `refit()` 是空操作（`visibleRef`），而且 `display:none` 时
    // 容器是 0×0，只有回到全速渲染的那一帧才量得出真实尺寸。
    const frame = requestAnimationFrame(refit);
    return () => cancelAnimationFrame(frame);
  }, [active, refit]);

  /* ----------------------------- 会话的建立 ------------------------------ */

  const hibernation = useHibernation(refs, {
    nodeId,
    patch,
    setSessionId,
    setAttempt,
  });
  const hibernated = status.connection === "hibernated";

  const ensureSession = useTerminalSession(refs, {
    nodeId,
    attempt,
    patch,
    setSessionId,
    onHibernated: hibernation.enter,
  });

  // core 替节点起的会话（冷启动、依赖编排）写进节点数据后，挂着的表面跟过去。
  useAdoptedSession(refs, {
    dataSessionId: data.sessionId,
    sessionId,
    patch,
    setSessionId,
  });

  /* ------------------------------ 启动行时序 ----------------------------- */

  const { clearLaunchTimers, armLaunch, noteOutput } = useLaunchSequence(refs, {
    nodeId,
    patch,
  });

  /* -------------------------------- 连接 --------------------------------- */

  useTerminalTransport(refs, {
    nodeId,
    sessionId,
    detached,
    hibernated,
    attempt,
    setAttempt,
    patch,
    refit,
    flushOutput,
    armLaunch,
    noteOutput,
    clearLaunchTimers,
  });

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

  useSurfaceHandle(refs, {
    ref,
    sessionId,
    ensureSession,
    patch,
    setAttempt,
  });

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
          open ? Boolean(refs.terminalRef.current?.hasSelection()) : false,
        )
      }
    >
      <ContextMenuTrigger asChild>
        <div
          ref={refs.bodyRef}
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
          // 只聚焦，不写任何字节给 PTY（§18.3 鼠标行）。休眠着的终端点一下就
          // 是唤醒（宿主设计 §7.2）。
          onPointerDown={() => {
            if (hibernated) hibernation.wake();
            refs.terminalRef.current?.focus();
          }}
          // 焦点进了终端（点进来、⌘F 之后跳回来、快捷键聚焦）即视为读过。
          // 同时也是渲染优先级的来源：xterm 6 没有公开的 onFocus/onBlur，
          // 焦点只能从容器的 focusin/focusout 看（§7.1「优先焦点实例」）。
          onFocusCapture={() => {
            if (hibernated) hibernation.wake();
            setFocused(true);
            const store = useAgentStatusStore.getState();
            if (store.statuses[nodeId]?.unread) store.markRead(nodeId);
          }}
          // 焦点在终端内部挪动（textarea ↔ helper 元素）不算失焦，
          // 否则每次输入法起落都会把渲染优先级抖一遍。
          onBlurCapture={(event) => {
            const next = event.relatedTarget as Node | null;
            if (next && refs.bodyRef.current?.contains(next)) return;
            setFocused(false);
          }}
        >
          <div
            ref={refs.containerRef}
            data-slot="terminal-surface"
            aria-label={t("terminal.label")}
            className="absolute inset-0"
            style={{ padding: TERMINAL_PADDING }}
          />
          {hibernated && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Button
                size="sm"
                variant="secondary"
                disabled={status.hibernation === "resuming"}
                onClick={hibernation.wake}
              >
                {t(
                  status.hibernation === "resuming"
                    ? "terminal.hibernation.resuming"
                    : "terminal.hibernation.wake",
                )}
              </Button>
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      {/* 菜单走 portal，开合不改变 body 尺寸（§18.2 规则 1）。 */}
      <ContextMenuContent className="z-[var(--z-dialog)]">
        <ContextMenuItem
          disabled={!hasSelection}
          onSelect={() =>
            writeClipboard(refs.terminalRef.current?.getSelection())
          }
        >
          {t("terminal.copy")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => void pasteIntoTerminal(refs.terminalRef.current)}
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
