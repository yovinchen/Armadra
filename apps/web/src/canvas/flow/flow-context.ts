import * as React from "react";
import type { ReactFlowInstance } from "@xyflow/react";
import type { Position } from "@armadra/shared";

/**
 * 全局 React Flow 句柄（React Flow 计划 §2.9 / §2.11，归属 canvas）。
 *
 * `FlowWorkspace` 挂载时把 `useReactFlow()` 的实例登记进来、卸载时清掉；
 * Dock / 命令面板 / 侧栏 / store 门面通过这里拿实例，**不许**各自
 * `useReactFlow()`——那个 hook 只能在 `<ReactFlowProvider>` 子树内用，
 * 而这些模块虽然在 provider 之下，却拿不到画布挂载与否的信息。
 *
 * 画布没挂载（启动页、单测）时一律返回 null，调用方必须自己兜底。
 */

/** 画布真正需要的那部分实例接口；测试里造一个假的比造整个实例便宜。 */
export type FlowHandle = ReactFlowInstance;

let current: FlowHandle | null = null;
let container: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function getFlow(): FlowHandle | null {
  return current;
}

export function setFlow(flow: FlowHandle | null): void {
  if (current === flow) return;
  current = flow;
  for (const listener of listeners) listener();
}

/** 画布容器（`.react-flow` 的宿主）。最大化与 fitView 要量它的像素尺寸。 */
export function setFlowContainer(element: HTMLElement | null): void {
  container = element;
}

export function getFlowContainer(): HTMLElement | null {
  return container;
}

/**
 * 画布容器的像素尺寸。没挂载时返回 `{width: 0, height: 0}`——调用方拿到的
 * 仍是合法尺寸，只是没有意义，总比抛异常好。
 */
export function containerSize(): { width: number; height: number } {
  if (!container) return { width: 0, height: 0 };
  const rect = container.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 订阅挂载 / 卸载；画布重建时组件会重新渲染并拿到新的实例。 */
export function useFlowHandle(): FlowHandle | null {
  return React.useSyncExternalStore(subscribe, getFlow, () => null);
}

/**
 * 屏幕坐标 → 画布坐标；画布未挂载时原样返回（右键菜单的兜底）。
 *
 * 名字沿用旧引擎的 `screenToPage`：React Flow 把同一件事叫
 * `screenToFlowPosition`，但调用方有十几处，换名字没有收益。
 */
export function screenToPage(point: Position): Position {
  const flow = current;
  if (!flow) return point;
  return flow.screenToFlowPosition({ x: point.x, y: point.y });
}

/** 会话侧栏 / 命令面板点一行 → 画布居中到那个节点。 */
export const CENTER_NODE_EVENT = "armadra:canvas:center-node";

export function requestCenterOnNode(nodeId: string): void {
  window.dispatchEvent(
    new CustomEvent(CENTER_NODE_EVENT, { detail: { nodeId } }),
  );
}
