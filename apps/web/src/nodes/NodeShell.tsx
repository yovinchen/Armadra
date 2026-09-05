import * as React from "react";
import type { CanvasNode } from "@armadra/shared";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Expand,
  Maximize2,
  Minimize2,
  X,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { StatusPill, type StatusTone } from "@/ui/status-pill";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { useCompactLayout } from "@/platform/layout";
import { canFocusOnPhone } from "@/shell/mobile-focus";
import { runCanvasCommand } from "@/canvas/commands";
import { getEditor } from "@/canvas/editor-context";
import { ConnectionHandles } from "@/canvas/shapes/ConnectionHandles";
import { NodeAnnotationHost, NodeMetaActions } from "@/meta/NodeMeta";
import { COLLAPSED_HEIGHT, DRAG_HANDLE_CLASS, nodeMeta } from "./registry";
import { HEADER_HEIGHT } from "./geometry";

/* -------------------------------------------------------------------------- */
/* 契约（计划书 §13.2）                                                        */
/* -------------------------------------------------------------------------- */

export interface NodeShellProps {
  node: CanvasNode;
  selected: boolean;
  /** 状态胶囊。不传就不渲染——空闲状态不占头部空间（§14 规则 1）。 */
  status?: { tone: StatusTone; label: string; pulse?: boolean };
  /** 光晕。包裹层伪元素只动画 opacity，不动画 box-shadow（§3.4）。 */
  glow?: "working" | "attention" | "unread";
  /** 状态胶囊左边的 chip（Agent 品牌色标、退出码…）。 */
  headerChips?: React.ReactNode;
  /** 右侧图标钮，排在「最大化 / 关闭」之前。 */
  headerActions?: React.ReactNode;
  /** `blocked` 且有 pendingId 时头部直接出现允许/拒绝两个内联按钮。 */
  approval?: {
    pendingId: string;
    onAnswer: (decision: "allow" | "deny") => void;
  };
  children: React.ReactNode;
}

/* -------------------------------------------------------------------------- */
/* 通用外壳                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 头部的 × 走画布的 `canvas.delete`，而不是直接 `removeNodes`：
 * 画布在 `onBeforeDelete` 上挂了「结束会话并删除？」确认框，绕过去
 * 就会让带 PTY 的终端节点被静默删掉。画布还没挂载时（单测、启动瞬间）
 * 命令表是空的，此时退回直接删除。
 */
function closeNode(id: string) {
  const store = useCanvasStore.getState();
  store.selectNodes([id]);
  if (!runCanvasCommand("canvas.delete")) {
    store.removeNodes([id]);
  }
}

/**
 * 头部按钮改文档之前，先把这个节点设成当前选中项。
 *
 * 点头部按钮不会经过 tldraw 的 select 工具（按钮自己吃掉了 pointerdown，
 * 否则一按就开始拖动整个 shape），所以选中态得我们自己补一次：折叠 /
 * 最大化都改尺寸，用户理应看到被改的那个节点是选中的。
 */
function focusNode(id: string): void {
  useCanvasStore.getState().selectNodes([id]);
}

/** 最大化后节点与视口之间留的边距（§3.4：最大化改真实 rect）。 */
const MAXIMIZE_MARGIN = 24;

/**
 * store 只负责记 premaxRect，目标矩形由画布算（§13.1）。
 *
 * tldraw 直接给页面坐标的视口矩形，边距是屏幕像素，所以要除以缩放再内缩。
 * 画布没挂载时（单测、启动瞬间）退回一个 1×1 的矩形：调用方拿到的仍是
 * 合法矩形，只是没有意义——总比抛异常好。
 */
export function maximizeRect(): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const editor = getEditor();
  if (!editor) return { x: 0, y: 0, width: 1, height: 1 };
  const bounds = editor.getViewportPageBounds();
  const margin = MAXIMIZE_MARGIN / (editor.getZoomLevel() || 1);
  return {
    x: bounds.x + margin,
    y: bounds.y + margin,
    width: Math.max(1, bounds.w - margin * 2),
    height: Math.max(1, bounds.h - margin * 2),
  };
}

/**
 * 节点体的事件守卫（tldraw 计划 §4.1 与 Phase 0 结论 2）。
 *
 * 指针：tldraw 的画布事件是 `.tl-canvas` 上的 React props，同一棵合成树，
 * 合成事件的 `stopPropagation` 就够——体内点击既不选中也不拖动，拖拽只认
 * 头部。这也是旧 `nodrag` 类的替代品：类名不再有任何行为。
 *
 * 滚轮：tldraw 的 wheel 是**原生**监听且挂在 `.tl-canvas` 上，React 19 的
 * 委托在更外层的 React 根，合成事件来不及。必须原生监听，而且分两相：
 *  - 冒泡相位挡普通滚轮（§18.5 的 tmux copy-mode 桥挂在更深的
 *    `[data-slot="terminal-body"]` 上，捕获相位会把它饿死）；
 *  - 捕获相位只拦 ⌘/Ctrl+滚轮，并转发一份到 `.tl-canvas`，让画布缩放的同时
 *    终端不跟着滚历史。
 */
function useNodeBodyGuards(ref: React.RefObject<HTMLElement | null>): void {
  React.useEffect(() => {
    const body = ref.current;
    if (!body) return;

    const onWheelCapture = (event: WheelEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      event.stopPropagation();
      const canvas = body.closest(".tl-container")?.querySelector(".tl-canvas");
      if (!canvas) return;
      canvas.dispatchEvent(new WheelEvent("wheel", event));
    };
    const onWheel = (event: WheelEvent) => {
      if (event.metaKey || event.ctrlKey) return;
      event.stopPropagation();
    };

    body.addEventListener("wheel", onWheelCapture, {
      passive: false,
      capture: true,
    });
    body.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      body.removeEventListener("wheel", onWheelCapture, { capture: true });
      body.removeEventListener("wheel", onWheel);
    };
  }, [ref]);
}

/**
 * 指针是否落在 tldraw 的叠加层（选中框的 resize / 旋转把手）上。
 *
 * 5.4 把把手画在叠加层画布上、命中完全靠几何：pointerdown 必须先到达
 * `.tl-canvas`，select 工具才会去问 `overlays.getOverlayAtPoint`。把手有一半
 * 压在节点体上，体如果一律吞掉 pointerdown，边缘的 resize 就永远拖不动
 * （2026-09-04 真实鼠标验证时发现）。所以只在**没有**命中叠加层时才拦。
 * 体内其它位置 `getOverlayAtPoint` 回 null，指示器不参与命中。
 */
function pointsAtOverlay(event: React.PointerEvent<HTMLElement>): boolean {
  const editor = getEditor();
  if (!editor) return false;
  const page = editor.screenToPage({ x: event.clientX, y: event.clientY });
  return Boolean(
    editor.overlays.getOverlayAtPoint(page, editor.getHitTestMargin()),
  );
}

function stopPointer(event: React.PointerEvent<HTMLElement>): void {
  if (pointsAtOverlay(event)) return;
  event.stopPropagation();
}

/**
 * 头部里的控件（按钮、输入框、标题）自己吃掉 pointerdown，其余头部区域
 * 放行给 tldraw 的 select 工具去拖动。选择器是 `nodrag` 类的替代品。
 */
const HEADER_CONTROLS =
  'button, input, textarea, select, [role="textbox"], [contenteditable="true"], [data-no-drag="true"]';

function onHeaderPointerDown(event: React.PointerEvent<HTMLElement>): void {
  const target = event.target as HTMLElement | null;
  // A read-only title fills the header's free space and remains a drag target.
  // Its click handler enters rename only when the pointer did not move.
  if (target?.closest('[data-node-title="true"]')) return;
  if (target?.closest(HEADER_CONTROLS) && !pointsAtOverlay(event)) {
    event.stopPropagation();
  }
}

export function NodeShell({
  node,
  selected,
  status,
  glow,
  headerChips,
  headerActions,
  approval,
  children,
}: NodeShellProps) {
  const meta = nodeMeta(node.type);
  const collapsed = node.collapsed === true;
  const maximized = useCanvasStore((state) =>
    Boolean(state.maximized?.[node.id]),
  );
  const bodyRef = React.useRef<HTMLDivElement>(null);
  useNodeBodyGuards(bodyRef);

  return (
    <div
      data-slot="node-shell"
      data-glow={glow}
      data-collapsed={collapsed ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-node-type={node.type}
      className="node-glow relative h-full w-full"
      style={collapsed ? { height: COLLAPSED_HEIGHT } : undefined}
    >
      {/* resize 把手由 tldraw 的选择框提供（`hideResizeHandles=false`），
          最小尺寸在 `ArmadraShapeUtil.onResize` 里按 `NODE_META.minSize` 夹住。 */}
      <div
        className={cn(
          "node-frame flex h-full w-full flex-col overflow-hidden rounded-[var(--r-card)]",
          "border border-[var(--border)] bg-[var(--card)]",
          selected && "border-[var(--brand)]",
        )}
      >
        <NodeHeader
          node={node}
          collapsed={collapsed}
          maximized={maximized}
          status={status}
          headerChips={headerChips}
          headerActions={headerActions}
          approval={approval}
        />

        {/* 折叠时只隐藏，不卸载：xterm / CodeMirror 的实例必须活着（§3.4） */}
        <div
          ref={bodyRef}
          data-slot="node-body"
          className="min-h-0 flex-1 overflow-hidden"
          style={collapsed ? { display: "none" } : undefined}
          // 体内指针事件不冒泡到 `.tl-canvas`：不选中、不拖动（§4.1）
          onPointerDown={stopPointer}
          onPointerMove={stopPointer}
          onPointerUp={stopPointer}
        >
          {children}
        </div>
      </div>

      {meta.hasBridgeHandles && <ConnectionHandles />}

      {/* 标注面板（评论 / 标签）。Dialog 走 portal，开合都不动节点尺寸。 */}
      <NodeAnnotationHost node={node} />
    </div>
  );
}

/* ---------------------------------- 头部 ---------------------------------- */

export function NodeHeader({
  node,
  collapsed,
  maximized,
  status,
  headerChips,
  headerActions,
  approval,
}: {
  node: CanvasNode;
  collapsed: boolean;
  maximized: boolean;
  status?: NodeShellProps["status"];
  headerChips?: React.ReactNode;
  headerActions?: React.ReactNode;
  approval?: NodeShellProps["approval"];
}) {
  const t = useT();
  const compact = useCompactLayout();
  return (
    <div
      data-slot="node-header"
      className={cn(
        DRAG_HANDLE_CLASS,
        "flex shrink-0 items-center gap-1.5 px-2",
        "bg-[var(--card)]",
      )}
      style={{ height: HEADER_HEIGHT }}
      // 头部是拖拽区：只有里面的控件吃掉 pointerdown，其余放行给 select 工具
      onPointerDown={onHeaderPointerDown}
    >
      <IconButton
        className="size-[20px]"
        label={collapsed ? t("node.expand") : t("node.collapse")}
        onClick={() => {
          focusNode(node.id);
          useCanvasStore.getState().setCollapsed(node.id, !collapsed);
        }}
      >
        {collapsed ? <ChevronRight /> : <ChevronDown />}
      </IconButton>

      <NodeTitle node={node} />

      <span className="node-header-chips flex min-w-0 items-center gap-1.5">
        {headerChips}
      </span>

      {status && (
        <span className="node-header-status">
          <StatusPill
            tone={status.tone}
            label={status.label}
            {...(status.pulse === undefined ? {} : { pulse: status.pulse })}
          />
        </span>
      )}

      {approval && (
        <span className="node-header-approval flex shrink-0 items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            className="text-[var(--success)]"
            aria-label={t("node.allow")}
            onClick={() => approval.onAnswer("allow")}
          >
            <Check />
            <span>{t("node.allow")}</span>
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="text-[var(--danger)]"
            aria-label={t("node.deny")}
            onClick={() => approval.onAnswer("deny")}
          >
            <X />
            <span>{t("node.deny")}</span>
          </Button>
        </span>
      )}

      {headerActions}

      {/* 评论 / AI 命名（§17）。终端不走这里：它的两项在自己的「更多」下拉里，
          头部必须保持一行 34px，多一个按钮也不能多一行。 */}
      {node.type !== "terminal" && <NodeMetaActions node={node} />}

      {/* 手机上「最大化」没有意义——画布本身就只有一屏宽。这一格换成进入
          单节点焦点页的入口，同一个 `focusNodeId`。 */}
      {compact && canFocusOnPhone(node.type) ? (
        <IconButton
          className="node-secondary-action"
          label={t("mobile.focus.open")}
          onClick={() => {
            focusNode(node.id);
            useCanvasStore.getState().setFocusNode(node.id);
          }}
        >
          <Expand />
        </IconButton>
      ) : (
        <IconButton
          className="node-secondary-action"
          label={maximized ? t("node.restore") : t("node.maximize")}
          onClick={() => {
            focusNode(node.id);
            const store = useCanvasStore.getState();
            if (maximized) store.restoreNode(node.id);
            else store.maximizeNode(node.id, maximizeRect());
          }}
        >
          {maximized ? <Minimize2 /> : <Maximize2 />}
        </IconButton>
      )}

      <IconButton
        className="node-secondary-action hover:text-[var(--danger)]"
        label={t("node.close")}
        onClick={() => closeNode(node.id)}
      >
        <X />
      </IconButton>
    </div>
  );
}

/** A click or Enter edits; dragging the title still moves the node. */
function NodeTitle({ node }: { node: CanvasNode }) {
  const t = useT();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(node.title);
  const active = React.useRef(false);
  const composing = React.useRef(false);
  const titleRef = React.useRef<HTMLSpanElement>(null);
  const pointerStart = React.useRef<{ x: number; y: number } | null>(null);
  const gestureCleanup = React.useRef<(() => void) | null>(null);
  const suppressClick = React.useRef(false);

  React.useEffect(() => () => gestureCleanup.current?.(), []);

  function begin() {
    gestureCleanup.current?.();
    suppressClick.current = false;
    active.current = true;
    composing.current = false;
    setDraft(node.title);
    setEditing(true);
  }

  function restoreFocus() {
    window.requestAnimationFrame(() => titleRef.current?.focus());
  }

  function startTitleGesture(event: React.PointerEvent<HTMLSpanElement>) {
    if (
      event.button !== 0 ||
      event.isPrimary === false ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      pointsAtOverlay(event)
    )
      return;
    // This title owns the touch gesture. Prevent Radix's enclosing canvas menu
    // from arming its long-press timer while tldraw captures the pointer.
    // Keep bubbling so the native canvas drag state still receives pointerdown.
    if (event.pointerType === "touch" || event.pointerType === "pen")
      event.preventDefault();
    gestureCleanup.current?.();
    const start = { x: event.clientX, y: event.clientY };
    pointerStart.current = start;
    suppressClick.current = false;
    let dragged = false;
    const distance = (next: PointerEvent) =>
      Math.hypot(next.clientX - start.x, next.clientY - start.y);
    const move = (next: PointerEvent) => {
      if (next.pointerId === event.pointerId && distance(next) > 4)
        dragged = true;
    };
    const cancel = () => {
      suppressClick.current = true;
      cleanup();
    };
    const key = (next: KeyboardEvent) => {
      if (next.key === "Escape") cancel();
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      suppressClick.current =
        dragged ||
        distance(next) > 4 ||
        next.shiftKey ||
        next.ctrlKey ||
        next.metaKey ||
        next.altKey;
      cleanup();
      // tldraw captures pointerup and click on its canvas. Wait until its
      // pointing state settles, then turn a short press into inline rename.
      if (!suppressClick.current)
        queueMicrotask(() => {
          if (titleRef.current?.isConnected) begin();
        });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      pointerStart.current = null;
      gestureCleanup.current = null;
    };
    gestureCleanup.current = cleanup;
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
  }

  function commit(value: string, focus = false) {
    // A cancelled/committed input may still emit blur before React removes it.
    if (!active.current) return;
    active.current = false;
    setEditing(false);
    const title = value.trim();
    if (title && title !== node.title) {
      useCanvasStore.getState().updateNode(node.id, { title });
    }
    if (focus) restoreFocus();
  }

  if (editing) {
    return (
      <Input
        autoFocus
        aria-label={t("node.title")}
        className="node-title h-7 min-w-0 flex-1 px-1.5 text-[length:var(--text-body)]"
        value={draft}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onBlur={(event) => commit(event.target.value)}
        onKeyDownCapture={(event) => {
          // tldraw has native key listeners inside the React root. Capture is
          // required to isolate input before those listeners can blur it.
          event.stopPropagation();
          if (
            composing.current ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          )
            return;
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            commit(event.currentTarget.value, true);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            active.current = false;
            setDraft(node.title);
            setEditing(false);
            restoreFocus();
          }
        }}
      />
    );
  }

  return (
    <span
      ref={titleRef}
      data-node-title="true"
      role="textbox"
      tabIndex={0}
      title={node.title}
      className="node-title min-w-0 flex-1 cursor-text truncate rounded-sm text-[length:var(--text-body)] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onPointerDown={startTitleGesture}
      onClick={(event) => {
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
          return;
        const start = pointerStart.current;
        pointerStart.current = null;
        if (suppressClick.current) return;
        if (
          start &&
          Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4
        )
          return;
        // Screen readers and synthetic clicks have no pointer gesture.
        if (event.detail === 0) begin();
      }}
      onKeyDownCapture={(event) => {
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
          return;
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          begin();
        }
      }}
    >
      {node.title}
    </span>
  );
}
