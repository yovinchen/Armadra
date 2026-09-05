/**
 * 资源采样的订阅生命周期（T02，终端宿主设计 §8）。
 *
 * **面板打开才采样。** 打开时申请一份带 TTL 的订阅，之后每个采样间隔续约
 * 一次；样本由 Runtime 通过已经开着的工作空间事件流以 `resource.sample`
 * 推下来，这里不轮询。关闭面板时退订，Runtime 的采样循环在最后一份订阅
 * 过期后自己停掉——所以关着的面板一分钱 CPU 都不花。
 *
 * 首屏走一次 `GET`：那条请求会让 Runtime 先垫一次 CPU 基线再采，拿到的是
 * 真实数字，而不是「第一次刷新恒为 0」。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ResourceSnapshot } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { onWorkspaceEvent } from "@/api/events";

/** 续约失败重试的上限间隔；Runtime 不在时不要每秒敲门。 */
const MAX_RETRY_MS = 15_000;

export interface ResourcesState {
  snapshot: ResourceSnapshot | null;
  error: string | null;
  /** 首屏还没到。已经有过样本之后即使正在重取也不再是 loading。 */
  loading: boolean;
  refresh: () => void;
}

export function useResources(
  workspaceId: string | null,
  enabled: boolean,
): ResourcesState {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  // 订阅 id 放 ref：续约要拿到最新值，但它变化不该触发重渲染。
  const subscriptionRef = useRef<string | null>(null);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  /* 推送：只要面板开着就收，和订阅的建立顺序无关。 */
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    return onWorkspaceEvent("resource.sample", (event) => {
      if (event.snapshot.workspaceId !== workspaceId) return;
      setSnapshot(event.snapshot);
      setLoading(false);
      setError(null);
    });
  }, [enabled, workspaceId]);

  /* 首屏 + 订阅 + 续约。 */
  useEffect(() => {
    if (!enabled || !workspaceId) {
      setSnapshot(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setLoading(true);

    const fail = (cause: unknown) => {
      if (cancelled) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
    };

    // 首屏。失败不影响订阅：推送照样可能到。
    void runtimeApi
      .resources(workspaceId, controller.signal)
      .then((first) => {
        if (cancelled) return;
        setSnapshot((current) => current ?? first);
        setError(null);
        setLoading(false);
      })
      .catch(fail);

    const renew = async () => {
      try {
        const subscription = await runtimeApi.subscribeResources(
          workspaceId,
          subscriptionRef.current ?? undefined,
        );
        if (cancelled) {
          // 组件已经卸载：把刚拿到的订阅还回去，别留一份没人要的采样。
          void runtimeApi
            .unsubscribeResources(workspaceId, subscription.subscriptionId)
            .catch(() => {});
          return;
        }
        subscriptionRef.current = subscription.subscriptionId;
        setError(null);
        timer = setTimeout(() => void renew(), subscription.intervalMs);
      } catch (cause) {
        fail(cause);
        if (!cancelled) timer = setTimeout(() => void renew(), MAX_RETRY_MS);
      }
    };
    void renew();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      const held = subscriptionRef.current;
      subscriptionRef.current = null;
      if (held) {
        void runtimeApi.unsubscribeResources(workspaceId, held).catch(() => {});
      }
    };
  }, [enabled, workspaceId, nonce]);

  return { snapshot, error, loading, refresh };
}
