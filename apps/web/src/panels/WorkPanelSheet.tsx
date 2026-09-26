import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { Sheet, SheetContent } from "@/ui/sheet";
import { useCompactLayout } from "../platform/layout";
import { useCanvasStore, type PanelState } from "../store/canvas-store";
import { noDragProps } from "../shell/window-region";

/**
 * 工作面板的外壳（画布平台设计 §4）。
 *
 * 九个面板——资源管理器、源码控制 / Git 工具窗口、GitHub、资源、自动化、
 * 交接历史、诊断、用量看板——共用**同一块地方**，所以它们的开合规矩也必须
 * 是同一份：
 *
 * 1. **非模态**。画布始终可见可操作（§4 第一句）。以前只有资源管理器和用量
 *    看板写了 `modal={false}`，其余六个是模态的：源码控制一开，整块画布连同
 *    右上工具簇、Dock 全被那层遮罩挡住，点「资源管理器」「打开用量看板」都
 *    像是没反应——用户看到的只有源码控制抽屉自己的「重新读取」。
 * 2. **不因为点到外面就关**。这是一块停靠的工作面板，不是气泡：在画布上点一下
 *    不该把它收走。而且 Radix 的外部关闭发生在 `pointerdown`，比按钮的
 *    `click` 早一步——工具簇那颗按钮于是永远在「刚被关掉」的状态上再开一次，
 *    抽屉根本关不掉。关闭走标题栏的 ×、工具簇按钮，或 Esc。
 *
 * 「一次只开一个」不在这里，在 `store/canvas/board.ts` 的 `setPanel`：那是
 * 状态的规矩，两个面板同时占着那块地方本身就不该出现。
 *
 * 停靠方向由调用方给（Git 工具窗口设计 §2.1 把 Git 停到底部，因为三栏要的是
 * 宽度不是高度）；底部形态多两件事：一条可拖的上边沿，和「最大化」。
 */

/**
 * 右侧停靠的面板与它们的抽屉宽度。
 *
 * 右上工具簇也读这张表：抽屉是窗口级的固定层，盖住了工具簇那一条，不让开
 * 的话开着抽屉时那几个按钮一个都按不到（`shell/ControlsCluster`）。
 *
 * Git 工具窗口**不在表里**：它停在底部，横向不盖住任何东西，高度由偏好决定
 * （`--git-window-h`）。给它一个用不到的宽度只会让下一个读这张表的人以为它
 * 也是右侧抽屉。
 */
export const WORK_PANEL_WIDTH = {
  explorer: "var(--drawer-w)",
  resources: "var(--drawer-w)",
  problems: "var(--drawer-w)",
  usage: "400px",
  github: "var(--scm-w)",
  automation: "var(--scm-w)",
  handoff: "var(--scm-w)",
} as const;

/** 右侧停靠的那几块。 */
export type RightPanelKey = keyof typeof WORK_PANEL_WIDTH;

/**
 * 钉住（`pinned`）的两块不是抽屉，是离右边 14px、从 96px 到底边 14px 的浮动
 * 卡片（`ExplorerDrawer`、`UsageDashboard`）。宽度写在这里，让 Dock 与卡片读
 * 同一个数。
 */
export const PINNED_PANEL_WIDTH = {
  explorer: "320px",
  usage: "360px",
} as const;

/** 开着的那块右侧抽屉；没有就 `null`。「一次只开一个」由 `setPanel` 保证。 */
export function openRightDrawer(panels: PanelState): RightPanelKey | null {
  for (const key of Object.keys(WORK_PANEL_WIDTH) as RightPanelKey[]) {
    if (panels[key] === "drawer") return key;
  }
  return null;
}

/**
 * 右侧工作面板从窗口右边占掉多宽（一个 CSS 长度），画布底部那一行要让开的
 * 就是它（§58：1440 宽开着资源管理器时 Dock 右端被抽屉盖住，缩放百分比只
 * 露出「10」）。抽屉贴边，宽度就是抽屉宽；钉住的卡片再加它自己离右边的
 * 14px。没有开着的就是 `null`。
 */
export function rightPanelInset(panels: PanelState): string | null {
  const drawer = openRightDrawer(panels);
  if (drawer) return `min(100vw, ${WORK_PANEL_WIDTH[drawer]})`;
  for (const key of Object.keys(PINNED_PANEL_WIDTH) as Array<
    keyof typeof PINNED_PANEL_WIDTH
  >) {
    if (panels[key] === "pinned")
      return `calc(${PINNED_PANEL_WIDTH[key]} + 14px)`;
  }
  return null;
}

/**
 * 手机上底部导航（`shell/MobileBottomNav`）占掉的高度；导航不在时为 `null`。
 * 与导航自己的显示条件一致：窄屏，且不在单节点焦点页上。
 */
function useMobileNavInset(): string | null {
  const compact = useCompactLayout();
  const focusNodeId = useCanvasStore((state) => state.focusNodeId);
  return compact && !focusNodeId
    ? "calc(var(--mobile-nav-h) + env(safe-area-inset-bottom))"
    : null;
}
/** 全部工作面板：右侧那几块，加上底部停靠的 Git 工具窗口。 */
export type WorkPanelKey = RightPanelKey | "scm";

function rightDocked(panel: WorkPanelKey): panel is RightPanelKey {
  return panel !== "scm";
}

/** 底部停靠时高度的上下限（px）。上限留出一点画布，最大化才是「铺满」。 */
export const BOTTOM_PANEL_MIN_HEIGHT = 160;
export function bottomPanelMaxHeight(viewport: number) {
  return Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.round(viewport * 0.92));
}

export interface WorkPanelSheetProps {
  panel: WorkPanelKey;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 停靠方向。缺省 `right`，历史上的八个抽屉都是它。 */
  side?: "right" | "bottom";
  /**
   * 底部停靠的高度，px。`null` = 用 `--git-window-h` 的默认值（40vh）。
   * 只在 `side="bottom"` 且没有最大化时生效。
   */
  height?: number | null;
  /** 拖上边沿改高度；不给就没有拖拽把手。 */
  onHeightChange?: (height: number) => void;
  /** 最大化：铺满整块画布区，忽略 `height`。 */
  maximized?: boolean;
  /** 无障碍名。底部窗口不用 `SheetTitle` 时由它命名对话框。 */
  label?: string;
  /** 拖拽把手的无障碍名；缺省时把手无名，屏读器只会念「分隔条」。 */
  resizeLabel?: string;
}

export function WorkPanelSheet({
  panel,
  open,
  onClose,
  children,
  side = "right",
  height = null,
  onHeightChange,
  maximized = false,
  label,
  resizeLabel,
}: WorkPanelSheetProps) {
  const bottom = side === "bottom";
  const compact = useCompactLayout();
  const navInset = useMobileNavInset();
  const dragging = useRef<{ startY: number; startHeight: number } | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);

  /**
   * 拖拽在 window 上收指针事件，而不是在把手上：指针跑出把手（拖得快的时候
   * 必然发生）之后仍然要跟手，松开也仍然要停。
   */
  useEffect(() => {
    if (!onHeightChange) return;
    const move = (event: PointerEvent) => {
      const start = dragging.current;
      if (!start) return;
      event.preventDefault();
      const next = start.startHeight + (start.startY - event.clientY);
      onHeightChange(
        Math.min(
          bottomPanelMaxHeight(window.innerHeight),
          Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.round(next)),
        ),
      );
    };
    const stop = () => {
      dragging.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [onHeightChange]);

  const startDrag = useCallback((event: ReactPointerEvent) => {
    const measured = surface.current?.getBoundingClientRect().height ?? 0;
    dragging.current = { startY: event.clientY, startHeight: measured };
  }, []);

  /** 键盘也要能改高度：把手是 `separator`，上下键各 24px。 */
  const nudge = useCallback(
    (delta: number) => {
      if (!onHeightChange) return;
      const measured = surface.current?.getBoundingClientRect().height ?? 0;
      onHeightChange(
        Math.min(
          bottomPanelMaxHeight(window.innerHeight),
          Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.round(measured + delta)),
        ),
      );
    },
    [onHeightChange],
  );

  return (
    <Sheet
      open={open}
      modal={false}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        ref={surface}
        side={bottom ? "bottom" : "right"}
        showCloseButton={false}
        aria-label={label}
        // A right-docked panel's header sits inside the window-drag strip
        // (`WindowDragLayer`, the top 44px), and Chromium resolves
        // `-webkit-app-region: drag` from geometry, not stacking: a real
        // click on the title, pin or close button dragged the window while a
        // synthetic one landed. `no-drag` carves the whole surface out.
        {...noDragProps()}
        aria-describedby={undefined}
        onInteractOutside={(event) => event.preventDefault()}
        //
        // 手机上（§58）：右侧抽屉按 `min(100vw, 360px)` 开，390 宽时左边留一条
        // 30px 的缝，底部导航也被盖住。窄屏改为铺满宽度、底边停在导航上方——
        // 与导航「一次只看一样东西」的约定一致：切到别的去处或点「画布」就是
        // 返回。底部停靠的窗口同理，最大化也只铺到导航上沿。
        style={
          bottom
            ? {
                height: maximized
                  ? navInset
                    ? `calc(100dvh - ${navInset})`
                    : "100dvh"
                  : height !== null
                    ? `${height}px`
                    : "var(--git-window-h)",
                maxHeight: navInset ? `calc(100dvh - ${navInset})` : "100dvh",
                ...(navInset ? { bottom: navInset } : {}),
              }
            : rightDocked(panel)
              ? compact
                ? {
                    width: "100vw",
                    height: "auto",
                    ...(navInset ? { bottom: navInset } : {}),
                  }
                : { width: `min(100vw, ${WORK_PANEL_WIDTH[panel]})` }
              : undefined
        }
        // `data-[side=right]:sm:max-w-none` 必须照抄这个变体：生成组件里的
        // `data-[side=right]:sm:max-w-sm`（384px）比裸 `sm:max-w-none` 特异性
        // 高，不写这一条的话 460px 的源码控制会被悄悄压到 384。
        className="max-w-full gap-0 p-0 data-[side=right]:sm:max-w-none"
      >
        {bottom && onHeightChange && !maximized && (
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={resizeLabel}
            tabIndex={0}
            data-slot="work-panel-resize"
            onPointerDown={startDrag}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp") {
                event.preventDefault();
                nudge(24);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                nudge(-24);
              }
            }}
            className="absolute inset-x-0 top-0 z-10 h-1.5 cursor-ns-resize hover:bg-[var(--brand)]/40 focus-visible:bg-[var(--brand)]/40 focus-visible:outline-none"
          />
        )}
        {children}
      </SheetContent>
    </Sheet>
  );
}
