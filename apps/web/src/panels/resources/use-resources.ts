/**
 * 资源采样的 React 接口（T02，终端宿主设计 §8）。
 *
 * 订阅本身在 [`sampling`](./sampling.ts)：一个工作空间一份，面板和每个节点
 * 徽标共用。这里只负责把它接到组件生命周期上，并把状态搬进 React。
 *
 * **打开才采样。** 面板关掉、节点卸载，最后一个看客走了就退订，Runtime 的
 * 采样循环在最后一份订阅过期后自己停掉——关着的面板一分钱 CPU 都不花。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionResources } from "@armadra/shared";

import {
  joinSampling,
  type Cadence,
  type SamplingHandle,
  type SamplingState,
} from "./sampling";

export interface ResourcesState extends SamplingState {
  refresh: () => void;
}

const IDLE: SamplingState = { snapshot: null, error: null, loading: false };

export function useResources(
  workspaceId: string | null,
  enabled: boolean,
  cadence: Cadence = "fast",
): ResourcesState {
  const [state, setState] = useState<SamplingState>(IDLE);
  const handle = useRef<SamplingHandle | null>(null);

  useEffect(() => {
    if (!enabled || !workspaceId) {
      setState(IDLE);
      return;
    }
    const joined = joinSampling(workspaceId, cadence, setState);
    handle.current = joined;
    setState(joined.current());
    return () => {
      handle.current = null;
      joined.leave();
    };
    // `cadence` 只作为加入时的初始值；之后的变化走下面的 `setCadence`，
    // 那样节奏改变不会退订再订阅一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, workspaceId]);

  useEffect(() => {
    handle.current?.setCadence(cadence);
  }, [cadence]);

  const refresh = useCallback(() => handle.current?.refresh(), []);
  return { ...state, refresh };
}

/* ------------------------------ 单个会话的行 ------------------------------ */

/** 徽标真正用到的四格；其余字段变了不值得让它重画。 */
function sameRow(
  a: SessionResources | null,
  b: SessionResources | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.memoryBytes === b.memoryBytes &&
    a.cpuPercent === b.cpuPercent &&
    a.childCount === b.childCount &&
    a.generation === b.generation
  );
}

function rowOf(
  state: SamplingState,
  sessionId: string | null,
  generation: number | null,
): SessionResources | null {
  if (!sessionId) return null;
  return (
    state.snapshot?.sessions.find(
      (entry) =>
        entry.sessionId === sessionId &&
        (generation === null || entry.generation === generation),
    ) ?? null
  );
}

/**
 * **一个会话一行，不是整份快照。**
 *
 * `useResources` 把整个 `SamplingState` 搬进组件的 state：一屏三十个终端徽标
 * 就是每一个采样 tick 三十次 setState，每次拖着自己那棵 Popover 子树一起重渲
 * ——实测一次会话状态跳动里 `MemoryBadge` 为根的重渲有 180 次、约 3,000 个
 * 组件（`docs/status/canvas-performance-baseline.md` §4）。而每个徽标真正要的
 * 只有自己那一行的四个数字。
 *
 * 所以这里订阅同一个房间，但只在**自己这一行**变了的时候才 setState。数字没
 * 动的那些徽标一帧都不画——这就是 nodeterm `Canvas.tsx:1575-1579` 那条纪律
 * （「只订阅一个会变的签名」）落在资源采样上的形状。
 */
export function useSessionResources(
  workspaceId: string | null,
  sessionId: string | null,
  generation: number | null,
  cadence: Cadence = "fast",
): SessionResources | null {
  const [row, setRow] = useState<SessionResources | null>(null);
  const handle = useRef<SamplingHandle | null>(null);
  // 比较要用最新的会话 id，但换会话不该退订再订阅一次。
  const target = useRef({ sessionId, generation });
  target.current = { sessionId, generation };

  useEffect(() => {
    if (!workspaceId || !sessionId) {
      setRow(null);
      return;
    }
    const accept = (state: SamplingState) => {
      const next = rowOf(
        state,
        target.current.sessionId,
        target.current.generation,
      );
      setRow((current) => (sameRow(current, next) ? current : next));
    };
    const joined = joinSampling(workspaceId, cadence, accept);
    handle.current = joined;
    accept(joined.current());
    return () => {
      handle.current = null;
      joined.leave();
    };
    // `cadence` 同 `useResources`：只作加入时的初值，之后走 `setCadence`。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, sessionId]);

  useEffect(() => {
    handle.current?.setCadence(cadence);
  }, [cadence]);

  return row;
}
