import { useEffect, useState } from "react";
import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { runtimeApi } from "../api/client";

/** Both usage surfaces read the same cache; only an explicit refresh hits providers. */
export function useUsage(enabled = true) {
  const queryClient = useQueryClient();
  const refreshing = useIsMutating({ mutationKey: ["usage-refresh"] }) > 0;
  const refreshStates = useMutationState({
    filters: { mutationKey: ["usage-refresh"] },
    select: (mutation) => mutation.state.status,
  });
  const refreshFailed = refreshStates.at(-1) === "error";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  const usage = useQuery({
    queryKey: ["usage"],
    queryFn: () => runtimeApi.usage(),
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: false,
    enabled,
  });
  const refresh = useMutation({
    mutationKey: ["usage-refresh"],
    mutationFn: () => runtimeApi.refreshUsage(),
    onMutate: () => queryClient.cancelQueries({ queryKey: ["usage"] }),
    onSuccess: (next) => {
      queryClient.setQueryData(["usage"], next);
      setNow(Date.now());
    },
  });
  const availableAt = Date.parse(usage.data?.refreshAvailableAt ?? "");
  const cooldown = Number.isFinite(availableAt)
    ? Math.max(0, Math.ceil((availableAt - now) / 1000))
    : 0;
  return { usage, refresh, refreshing, refreshFailed, now, cooldown };
}
