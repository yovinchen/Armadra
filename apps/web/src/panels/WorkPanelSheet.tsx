import type { ReactNode } from "react";

import { Sheet, SheetContent } from "@/ui/sheet";

/**
 * 右侧工作面板的外壳（画布平台设计 §4）。
 *
 * 八个抽屉——资源管理器、源码控制、GitHub、资源、自动化、交接历史、诊断、
 * 用量看板——共用右边这**同一块地方**，所以它们的开合规矩也必须是同一份：
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
 * 状态的规矩，两个抽屉同时为 `drawer` 本身就不该出现。
 */

/**
 * 每块面板的抽屉宽度。
 *
 * 右上工具簇也读这张表：抽屉是窗口级的固定层，盖住了工具簇那一条，不让开
 * 的话开着抽屉时那几个按钮一个都按不到（`shell/ControlsCluster`）。
 */
export const WORK_PANEL_WIDTH = {
  explorer: "var(--drawer-w)",
  resources: "var(--drawer-w)",
  problems: "var(--drawer-w)",
  usage: "400px",
  scm: "var(--scm-w)",
  github: "var(--scm-w)",
  automation: "var(--scm-w)",
  handoff: "var(--scm-w)",
} as const;

export type WorkPanelKey = keyof typeof WORK_PANEL_WIDTH;

export interface WorkPanelSheetProps {
  panel: WorkPanelKey;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function WorkPanelSheet({
  panel,
  open,
  onClose,
  children,
}: WorkPanelSheetProps) {
  return (
    <Sheet
      open={open}
      modal={false}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        onInteractOutside={(event) => event.preventDefault()}
        style={{ width: `min(100vw, ${WORK_PANEL_WIDTH[panel]})` }}
        // `data-[side=right]:sm:max-w-none` 必须照抄这个变体：生成组件里的
        // `data-[side=right]:sm:max-w-sm`（384px）比裸 `sm:max-w-none` 特异性
        // 高，不写这一条的话 460px 的源码控制会被悄悄压到 384。
        className="max-w-full gap-0 p-0 data-[side=right]:sm:max-w-none"
      >
        {children}
      </SheetContent>
    </Sheet>
  );
}
