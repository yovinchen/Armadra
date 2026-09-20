import * as React from "react";
import type { CanvasNode } from "@armadra/shared";
import {
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  Expand,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PencilLine,
  X,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { StatusPill, type StatusTone } from "@/ui/status-pill";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { useCompactLayout } from "@/platform/layout";
import { canFocusOnPhone } from "@/shell/mobile-focus";
import { runCanvasCommand } from "@/canvas/commands";
import { containerSize, getFlow } from "@/canvas/flow/flow-context";
import { ConnectionHandles } from "@/canvas/flow/nodes/ConnectionHandles";
import {
  isZoomWheel,
  zoomCanvasByWheel,
} from "@/canvas/interaction/wheel-zoom";
import { NodeAnnotationHost, NodeMetaMenuItems } from "@/meta/NodeMeta";
import { HeaderChips } from "./HeaderChips";
import { NodeNameBadge } from "./NodeNameBadge";
import { SupervisionBadge } from "./SupervisionBadge";
import { requestNodeNames } from "./node-names";
import { COLLAPSED_HEIGHT, DRAG_HANDLE_CLASS, nodeMeta } from "./registry";
import { HEADER_HEIGHT } from "./geometry";

/* -------------------------------------------------------------------------- */
/* 契约（计划书 §13.2；头部精简见用户实测反馈 F5）                              */
/* -------------------------------------------------------------------------- */

export interface NodeShellProps {
  node: CanvasNode;
  selected: boolean;
  /** 状态胶囊。不传就不渲染——空闲状态不占头部空间（§14 规则 1）。 */
  status?: { tone: StatusTone; label: string; pulse?: boolean };
  /** 光晕。包裹层伪元素只动画 opacity，不动画 box-shadow（§3.4）。 */
  glow?: "working" | "attention" | "unread";
  /**
   * 标题**左边**的一个小标记（状态来源的色点）。只放「一个点 + 悬停提示」
   * 这一量级的东西：它常驻在每个节点上，多一个词就是每个节点多一个词。
   */
  headerMark?: React.ReactNode;
  /**
   * 状态胶囊左边的常驻徽标。F5 之后这里只留「一眼就要看到」的那几个
   * （内存，以及只在异常时才出现的提示），其余一律进 `···` 菜单。
   */
  headerChips?: React.ReactNode;
  /** 仍然留在头部的主操作图标钮，排在 `···` 之前。次要动作进菜单。 */
  headerActions?: React.ReactNode;
  /** `···` 菜单里由节点类型自己提供的条目，排在通用的视图项之前。 */
  menuItems?: React.ReactNode;
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
 * 点头部按钮不会经过 React Flow 的选择（按钮自己吃掉了 pointerdown，
 * 否则一按就开始拖动整个节点），所以选中态得我们自己补一次：折叠 /
 * 最大化都改尺寸，用户理应看到被改的那个节点是选中的。
 */
function focusNode(id: string): void {
  useCanvasStore.getState().selectNodes([id]);
}

/** 最大化后节点与视口之间留的边距（§3.4：最大化改真实 rect）。 */
const MAXIMIZE_MARGIN = 24;

/**
 * store 只负责记 premaxRect，目标矩形由画布算（§1.2 F04）。
 *
 * React Flow 只给 `{x, y, zoom}`，视口矩形要自己从容器尺寸换算：左上角是
 * `-x/zoom`，宽高是 `容器尺寸/zoom`。边距是屏幕像素，所以除以缩放再内缩。
 * 画布没挂载时（单测、启动瞬间）退回一个 1×1 的矩形：调用方拿到的仍是
 * 合法矩形，只是没有意义——总比抛异常好。
 */
export function maximizeRect(): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const flow = getFlow();
  const { width, height } = containerSize();
  if (!flow || width <= 0 || height <= 0) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  const viewport = flow.getViewport();
  const zoom = viewport.zoom || 1;
  const margin = MAXIMIZE_MARGIN / zoom;
  return {
    x: -viewport.x / zoom + margin,
    y: -viewport.y / zoom + margin,
    width: Math.max(1, width / zoom - margin * 2),
    height: Math.max(1, height / zoom - margin * 2),
  };
}

/**
 * 节点体的滚轮守卫（React Flow 计划 F02）。
 *
 * 指针事件不再需要守卫：拖拽只从 `dragHandle`（头部）起，体内的
 * pointerdown 本来就不会拖动节点，也不会被 React Flow 拦下来。点一下体
 * 会把节点选中——这是有意为之（§1.3），⌘方向键导航从此不必先点头部。
 *
 * 滚轮仍然要守：
 *  - `nowheel` 类挡住普通滚轮，让终端的 tmux 滚屏桥与编辑器自己滚；
 *  - 捕获相位把 ⌘/Ctrl+滚轮**自己算成一次缩放**（`interaction/wheel-zoom.ts`），
 *    画布照常缩放，终端不跟着滚历史。
 *
 * 以前这里是把事件转发一份到 `.react-flow__pane`，让 d3-zoom 去处理。那条路
 * 在终端拿到键盘焦点时会失灵：React Flow 判定「缩放还是平移」看的是
 * `useKeyPress(zoomActivationKeyCode)`，而 keydown 落在 xterm 的隐藏 textarea
 * 上时画布这边的 Meta 可能从没「按下过」，同一个手势于是变成平移（§6.3 A01）。
 * 自己算就与键盘焦点无关了。
 */
function useNodeBodyGuards(ref: React.RefObject<HTMLElement | null>): void {
  React.useEffect(() => {
    const body = ref.current;
    if (!body) return;

    const onWheelCapture = (event: WheelEvent) => {
      if (!isZoomWheel(event)) return;
      // 终端不该跟着滚历史，浏览器也不该做页面缩放。
      event.preventDefault();
      event.stopPropagation();
      zoomCanvasByWheel(event);
    };

    body.addEventListener("wheel", onWheelCapture, {
      passive: false,
      capture: true,
    });
    return () =>
      body.removeEventListener("wheel", onWheelCapture, { capture: true });
  }, [ref]);
}

/**
 * 头部里的控件（按钮、输入框）自己吃掉 pointerdown，其余头部区域——包括
 * 那个只读标题——放行给 React Flow 去拖动（F4：整个头部都是拖拽区）。
 */
const HEADER_CONTROLS =
  'button, input, textarea, select, [contenteditable="true"], [data-no-drag="true"]';

function onHeaderPointerDown(event: React.PointerEvent<HTMLElement>): void {
  const target = event.target as HTMLElement | null;
  // A read-only title fills the header's free space and remains a drag target.
  // Renaming is a double click, so a press on it must reach the node drag.
  if (target?.closest('[data-node-title="true"]')) return;
  if (target?.closest(HEADER_CONTROLS)) event.stopPropagation();
}

export function NodeShell({
  node,
  selected,
  status,
  glow,
  headerMark,
  headerChips,
  headerActions,
  menuItems,
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
      {/* resize 把手由 `<NodeResizer>` 提供（`flow/nodes/ArmadraNode.tsx`），
          最小尺寸按 `NODE_META.minSize`。 */}
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
          headerMark={headerMark}
          headerChips={headerChips}
          headerActions={headerActions}
          menuItems={menuItems}
          approval={approval}
        />

        {/* 折叠时只隐藏，不卸载：xterm / CodeMirror 的实例必须活着（§3.4） */}
        <div
          ref={bodyRef}
          data-slot="node-body"
          // `nowheel`：普通滚轮归节点体自己（终端的 tmux 桥、编辑器的滚动），
          // 不缩放画布；`nodrag`：体内按下不拖节点，拖拽只从头部起（F02）。
          className="nodrag nowheel min-h-0 flex-1 overflow-hidden"
          style={collapsed ? { display: "none" } : undefined}
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

/**
 * 一行 `HEADER_HEIGHT`（2026-09-19 起 30px），从左到右只有五样东西（F5）：
 * 来源色点 → 标题 → 常驻徽标（内存）→ 状态胶囊 → `···` → ×。
 *
 * 折叠、最大化、搜索、上下文占用、Agent 名全部收进 `···`：用户的原话是
 * 「头部信息太多，只想看内存」。
 */
export function NodeHeader({
  node,
  collapsed,
  maximized,
  status,
  headerMark,
  headerChips,
  headerActions,
  menuItems,
  approval,
}: {
  node: CanvasNode;
  collapsed: boolean;
  maximized: boolean;
  status?: NodeShellProps["status"];
  headerMark?: React.ReactNode;
  headerChips?: React.ReactNode;
  headerActions?: React.ReactNode;
  menuItems?: React.ReactNode;
  approval?: NodeShellProps["approval"];
}) {
  const t = useT();
  // 改名的开合放在头部：标题与 `···` 里的「重命名」是同一个入口，触屏上
  // 双击不好按，那一项就是它唯一能用的路。
  const [renaming, setRenaming] = React.useState(false);
  return (
    <div
      data-slot="node-header"
      className={cn(
        DRAG_HANDLE_CLASS,
        "flex shrink-0 items-center gap-1 px-1.5",
        "bg-[var(--card)]",
      )}
      style={{ height: HEADER_HEIGHT }}
      // 头部是拖拽区：只有里面的控件吃掉 pointerdown，其余放行给 select 工具
      onPointerDown={onHeaderPointerDown}
    >
      {headerMark}

      <NodeTitle node={node} editing={renaming} onEditing={setRenaming} />

      {/* Agent 之间的名字（设计 §2.3）。没起名就不画，所以它不占没名字的那些
          节点的头部；有名字时它排在类型自己的徽标之前，因为它是「这是谁」。 */}
      <NodeNameBadge node={node} />

      {/* 主从关系紧跟名字：两枚合起来才是「这是谁、他归谁」。 */}
      <SupervisionBadge node={node} />

      <HeaderChips>{headerChips}</HeaderChips>

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

      <NodeMenu
        node={node}
        collapsed={collapsed}
        maximized={maximized}
        items={menuItems}
        onRename={() => setRenaming(true)}
      />

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

/**
 * 每种节点共用的 `···`。
 *
 * 顺序是「这个节点能做什么」→「怎么看它」→「怎么标注它」：节点自己的条目
 * 在最上面（终端的搜索 / 打断 / 模型…），然后是折叠与最大化，最后是 AI 命名
 * 与备注。所有节点类型走的都是这一个组件，所以菜单结构天然一致。
 */
function NodeMenu(props: {
  node: CanvasNode;
  collapsed: boolean;
  maximized: boolean;
  items?: React.ReactNode;
  onRename?: () => void;
}) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Revealed together with the close button: one control that is
            always there beside one that appears on hover reads as a glitch. */}
        <IconButton className="node-secondary-action" label={t("node.more")}>
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <NodeMenuContent {...props} />
    </DropdownMenu>
  );
}

/** 菜单正文单独导出：它是这些动作唯一的入口，测试要够得到它。 */
export function NodeMenuContent({
  node,
  collapsed,
  maximized,
  items,
  onRename,
}: {
  node: CanvasNode;
  collapsed: boolean;
  maximized: boolean;
  items?: React.ReactNode;
  onRename?: () => void;
}) {
  const t = useT();
  const compact = useCompactLayout();
  return (
    <DropdownMenuContent align="end" className="min-w-52">
      {items}
      {items ? <DropdownMenuSeparator /> : null}
      {/* 改名的第二个入口。触屏上双击标题不好按，而这一项和双击翻的是同一个
          开关，所以它不是「另一种改名」，只是同一条路的另一个门。 */}
      {onRename && (
        <DropdownMenuItem onSelect={onRename}>
          <PencilLine />
          {t("node.rename")}
        </DropdownMenuItem>
      )}
      {/* 名字是另一件事：标题是给人看的散文，名字是 Agent 之间的称呼，自动
          命名只改前者（设计 §2.1）。所以它是菜单里独立的一项。 */}
      <DropdownMenuItem onSelect={() => requestNodeNames([node.id])}>
        <AtSign />
        {t("node.name.edit")}
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          focusNode(node.id);
          useCanvasStore.getState().setCollapsed(node.id, !collapsed);
        }}
      >
        {collapsed ? <ChevronRight /> : <ChevronDown />}
        {collapsed ? t("node.expand") : t("node.collapse")}
      </DropdownMenuItem>
      {/* 手机上「最大化」没有意义——画布本身就只有一屏宽。这一格换成进入
            单节点焦点页的入口，同一个 `focusNodeId`。 */}
      {compact && canFocusOnPhone(node.type) ? (
        <DropdownMenuItem
          onSelect={() => {
            focusNode(node.id);
            useCanvasStore.getState().setFocusNode(node.id);
          }}
        >
          <Expand />
          {t("mobile.focus.open")}
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem
          onSelect={() => {
            focusNode(node.id);
            const store = useCanvasStore.getState();
            if (maximized) store.restoreNode(node.id);
            else store.maximizeNode(node.id, maximizeRect());
          }}
        >
          {maximized ? <Minimize2 /> : <Maximize2 />}
          {maximized ? t("node.restore") : t("node.maximize")}
        </DropdownMenuItem>
      )}
      <NodeMetaMenuItems node={node} />
    </DropdownMenuContent>
  );
}

/**
 * 静态标题：双击（或按 Enter / F2）改名，其余时候整块都是拖拽区。
 *
 * 以前是「短按一下就进编辑」，结果是文件管理器那种窄头部里想拖节点常常
 * 变成打开输入框（F4）。双击既不与拖拽冲突（React Flow 的拖拽阈值是 4px，
 * 两次原地点击不会触发），也和画布上其它「双击进入」的手势一致。
 */
function NodeTitle({
  node,
  editing,
  onEditing,
}: {
  node: CanvasNode;
  editing: boolean;
  onEditing: (editing: boolean) => void;
}) {
  const t = useT();
  const [draft, setDraft] = React.useState(node.title);
  const active = React.useRef(false);
  const composing = React.useRef(false);
  const titleRef = React.useRef<HTMLSpanElement>(null);

  // 菜单里的「重命名」只翻一个布尔，草稿与「这次编辑还活着吗」由这里补。
  React.useEffect(() => {
    if (!editing) return;
    active.current = true;
    composing.current = false;
    setDraft(node.title);
  }, [editing, node.title]);

  function begin() {
    onEditing(true);
  }

  function stop() {
    active.current = false;
    onEditing(false);
  }

  function restoreFocus() {
    window.requestAnimationFrame(() => titleRef.current?.focus());
  }

  function commit(value: string, focus = false) {
    // A cancelled/committed input may still emit blur before React removes it.
    if (!active.current) return;
    stop();
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
        className="node-title h-6 min-w-0 flex-1 px-1.5 text-[12px]"
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
          // The canvas has native key listeners inside the React root. Capture
          // is required to isolate input before those listeners can blur it.
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
            setDraft(node.title);
            stop();
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
      className="node-title min-w-0 flex-1 truncate rounded-sm text-[12px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onDoubleClick={(event) => {
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
          return;
        event.preventDefault();
        event.stopPropagation();
        begin();
      }}
      onKeyDownCapture={(event) => {
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
          return;
        if (event.key === "Enter" || event.key === "F2") {
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
