import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { runtimeApi } from "../api/client";
import { useAccess } from "./use-access";

/**
 * 本地成本汇总（§4.2）。
 *
 * Runtime 侧后台最快 5 分钟扫一次，手动刷新 30 秒冷却，所以这里的轮询
 * 只是「把缓存拿过来」，不会触发扫描；真正的重扫走 `refresh`。
 */
export function useCost(wanted = true) {
  // 用量与成本是 owner 自己的账户：服务器壳上的成员一律 403，别去问。
  const enabled = wanted && !useAccess().member;
  const queryClient = useQueryClient();
  const cost = useQuery({
    queryKey: ["usage-cost"],
    queryFn: () => runtimeApi.usageCost(),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
    enabled,
  });
  const refresh = useMutation({
    mutationKey: ["usage-cost-refresh"],
    mutationFn: () => runtimeApi.refreshUsageCost(),
    onSuccess: (next) => queryClient.setQueryData(["usage-cost"], next),
  });
  return { cost, refresh };
}
