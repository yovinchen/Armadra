import * as React from "react";

import { useOnScreen, usePageVisible } from "@/panels/resources/use-visibility";
import {
  OFFSCREEN_FLUSH_MS,
  drainOffscreenBuffer,
  rendersActively,
  resolveRenderState,
  type TerminalRenderState,
} from "../render-state";
import {
  RENDER_PRIORITY_FOCUSED,
  RENDER_PRIORITY_VISIBLE,
  claimRenderSlot,
} from "../render-budget";
import type { SurfaceRefs } from "./refs";
import type { TerminalConnection } from "./types";

export interface RenderBudget {
  render: TerminalRenderState;
  active: boolean;
  focused: boolean;
  setFocused: (value: boolean) => void;
  onScreen: boolean;
  pageVisible: boolean;
  flushOutput: () => void;
}

/**
 * 「有没有人在看」的那一半（终端宿主设计 §7.1）：视口 / 窗口前后台 / 焦点 /
 * 渲染名额算出渲染档位，并按档位决定输出是直写还是先攒到离屏缓冲里。
 */
export function useRenderBudget(
  refs: SurfaceRefs,
  options: {
    nodeId: string;
    collapsed: boolean;
    detached: boolean;
    connection: TerminalConnection;
  },
): RenderBudget {
  const { nodeId, collapsed, detached, connection } = options;

  /*
   * 三个「有没有人在看」的输入（设计 §7.1）。前两个复用资源徽标那套观测器：
   * 画布不裁剪节点（`canCull() => false`），离屏节点仍然挂在 DOM 上，只有
   * `IntersectionObserver` 说得出它其实在屏幕外。
   */
  const onScreen = useOnScreen(refs.bodyRef);
  const pageVisible = usePageVisible();
  const [focused, setFocused] = React.useState(false);
  const [budgeted, setBudgeted] = React.useState(false);

  const render = resolveRenderState({
    connection,
    collapsed,
    onScreen,
    pageVisible,
    focused,
    detached,
    budgeted,
  });
  const active = rendersActively(render);

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
    const terminal = refs.terminalRef.current;
    if (!terminal) return;
    const text = drainOffscreenBuffer(refs.bufferRef.current);
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

  return {
    render,
    active,
    focused,
    setFocused,
    onScreen,
    pageVisible,
    flushOutput,
  };
}
