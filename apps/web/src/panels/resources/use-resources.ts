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
