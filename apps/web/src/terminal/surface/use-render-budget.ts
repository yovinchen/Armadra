import * as React from "react";

import { useOnScreen, usePageVisible } from "@/panels/resources/use-visibility";
import {
  OFFSCREEN_FLUSH_MS,
  drainOffscreenBuffer,
  rendersActively,
  resolveRenderState,
  type TerminalRenderState,
} from "../render-state";
import { registerRenderClient, type RenderClient } from "../render-budget";
import type { SurfaceRefs } from "./refs";
import type { TerminalConnection } from "./types";

export interface RenderBudget {
  render: TerminalRenderState;
  active: boolean;
  /** 持有一个渲染名额：WebGL addon 的挂载条件（`render-budget.ts`）。 */
  budgeted: boolean;
  focused: boolean;
  setFocused: (value: boolean) => void;
  onScreen: boolean;
  pageVisible: boolean;
  flushOutput: () => void;
  /** 上报 `webglcontextlost`，由协调器决定要不要延迟重授。 */
  reportContextLoss: () => void;
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
   * 这里**只上报**，不决策：登记一次活到节点卸载，可见性与焦点变了就告诉协调
   * 器，授予、去抖、LRU 回收、丢上下文后的重授全在 `render-budget.ts` 里算。
   * 各节点各自「可见就取」会在快速平移时集体越过浏览器的上下文上限，触发强制
   * 驱逐——那正是 "lost context" 白框的来源。
   *
   * 登记与上报分成三个 effect，顺序即声明顺序：挂载那一帧先登记（初始状态不
   * 去抖），随后两个上报 effect 拿到的是同一个值，被去重挡掉。
   */
  const wantsSlot = !collapsed && onScreen && pageVisible && !detached;
  const clientRef = React.useRef<RenderClient | null>(null);
  /*
   * 挂载那一帧的状态，只在首渲染求值（`useRef` 的初值）。登记要当下的值，但值
   * 变了**不该**重新登记——那是 `setVisible` / `setFocused` 的事。之后哪怕
   * `nodeId` 真的换了，紧随其后的上报 effect 也会在同一个 commit 里纠正。
   */
  const initialRef = React.useRef({ visible: wantsSlot, focused });

  React.useEffect(() => {
    const client = registerRenderClient(
      nodeId,
      initialRef.current,
      setBudgeted,
    );
    clientRef.current = client;
    return () => {
      clientRef.current = null;
      client.dispose();
      // 销登记不会回调已经删掉的那条，不补的话状态会停在上一轮的 `true` 上。
      setBudgeted(false);
    };
  }, [nodeId]);

  React.useEffect(() => {
    clientRef.current?.setVisible(wantsSlot);
  }, [wantsSlot]);

  React.useEffect(() => {
    clientRef.current?.setFocused(focused);
  }, [focused]);

  const reportContextLoss = React.useCallback(() => {
    clientRef.current?.contextLost();
  }, []);

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
    budgeted,
    focused,
    setFocused,
    onScreen,
    pageVisible,
    flushOutput,
    reportContextLoss,
  };
}
