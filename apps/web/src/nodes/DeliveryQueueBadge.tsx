/**
 * 「排队 N」——排在这个终端前面的那些（设计 `agent-delivery.md` §4.6、§10）。
 *
 * 排在别人终端前面的东西，被排队的那个人要能看见；看得见还不够，他对自己的
 * 终端有最终决定权，所以每一条都能当场拒收。
 *
 * **数字不由页面自己加减。** `agent.delivery` 只说「这个节点的队伍动了」，
 * 真正的计数从 core 重读——队列会因为出队、取消、过期三种原因变短，页面按
 * 事件推算迟早会与那张表说两个数。空队列不画任何东西：没有人排队是常态。
 *
 * 浮层里另列最近几条投进来的，并标出**凭什么**放行的（迁移 0026 的
 * `targetState`）：目标自己报了空闲是「有上报」，没有上报、看着它安静了就投的
 * 是「按观察放行」。两种都以「已投递」收尾，可信度却不同，事后要分得出来。
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox } from "lucide-react";

import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import {
  onDeliveryQueueRequest,
  useDeliveryStore,
} from "@/agent/delivery-store";
import { formatRelativeTime } from "@/lib/format";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

export function DeliveryQueueBadge({
  nodeId,
  workspaceId,
}: {
  nodeId: string;
  workspaceId: string | null;
}) {
  const t = useT();
  const client = useQueryClient();
  const version = useDeliveryStore((state) => state.queueVersion[nodeId] ?? 0);
  const key = React.useMemo(
    () => ["delivery-queue", workspaceId, nodeId],
    [workspaceId, nodeId],
  );

  const queue = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      runtimeApi.deliveryQueue(workspaceId as string, nodeId, signal),
    enabled: workspaceId !== null,
    retry: false,
    // 队列项会自己过期（TTL 五分钟），所以即使一帧都没来也要偶尔重问一次。
    refetchInterval: 60_000,
  });

  const [open, setOpen] = React.useState(false);
  // 命令面板那条「查看 X 的投递队列」打开的就是这个浮层，不另画一份列表。
  React.useEffect(
    () =>
      onDeliveryQueueRequest((wanted) => {
        if (wanted !== nodeId) return;
        void client.invalidateQueries({ queryKey: key });
        setOpen(true);
      }),
    [client, key, nodeId],
  );

  // 队伍动了就重读。事件是「有事发生」，答案仍然来自 core。
  React.useEffect(() => {
    if (version === 0) return;
    void client.invalidateQueries({ queryKey: key });
  }, [client, key, version]);

  // 投递记录只在浮层打开时读：它是整个工作空间的表，徽标常驻时不该跟着拉。
  const historyKey = React.useMemo(
    () => ["deliveries", workspaceId, version],
    [workspaceId, version],
  );
  const history = useQuery({
    queryKey: historyKey,
    queryFn: () => runtimeApi.deliveries(workspaceId as string, 50),
    enabled: open && workspaceId !== null,
    retry: false,
  });
  const recent = (history.data ?? [])
    .filter(
      (record) =>
        record.targetNodeId === nodeId && record.outcome === "delivered",
    )
    .slice(0, RECENT_LIMIT);

  const items = queue.data ?? [];
  // 队空就不画——除非有人**问起**（命令面板那条）：那时空队列本身就是答案。
  if (items.length === 0 && !open) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Badge
          asChild
          variant="outline"
          className="h-[18px] px-1.5 text-[length:var(--text-caption)]"
          data-no-drag="true"
        >
          <button
            type="button"
            data-slot="delivery-queue"
            data-testid={`delivery-queue-${nodeId}`}
            aria-label={t("delivery.queued", { count: items.length })}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Inbox className="size-2.5" />
            {t("delivery.queued", { count: items.length })}
          </button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 max-w-[calc(100vw-1rem)] text-xs"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h3 className="font-medium">{t("delivery.queue.title")}</h3>
        {items.length === 0 ? (
          <p className="text-muted-foreground">{t("delivery.queue.empty")}</p>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">
                {t("delivery.queue.from", {
                  name: item.sourceName || item.sourceNodeId,
                  position: item.position,
                  chars: item.bodyChars,
                })}
                <span className="block truncate text-muted-foreground">
                  {formatRelativeTime(item.queuedAt * 1000)}
                  {item.reason === undefined
                    ? ""
                    : ` · ${t(`error.delivery.${item.reason}`)}`}
                </span>
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  void runtimeApi
                    .cancelDelivery(workspaceId as string, item.id)
                    .finally(() => client.invalidateQueries({ queryKey: key }));
                }}
              >
                {t("delivery.queue.cancel")}
              </Button>
            </li>
          ))}
        </ul>
        {recent.length > 0 ? (
          <>
            <h3 className="mt-2 font-medium">{t("delivery.recent.title")}</h3>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {recent.map((record) => {
                const basis = basisOf(record.targetState);
                return (
                  <li
                    key={record.traceId}
                    className="flex items-center gap-2"
                    data-slot="delivery-record"
                  >
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {t("delivery.recent.item", {
                        time: formatRelativeTime(Date.parse(record.createdAt)),
                        chars: record.bodyChars,
                      })}
                    </span>
                    {basis === undefined ? null : (
                      <Badge
                        variant={basis === "observed" ? "outline" : "secondary"}
                        className="h-[18px] px-1.5 text-[length:var(--text-caption)]"
                      >
                        {t(`delivery.basis.${basis}`)}
                      </Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** 浮层里最多列几条最近的投递。 */
const RECENT_LIMIT = 3;

/**
 * 回执里的 `targetState` → 凭什么放行的。`observed-quiet` 是没有上报、看着它
 * 安静了就投的那一类（core 的 `OBSERVED_QUIET`）；空串是 0026 之前的行，不标。
 */
function basisOf(targetState: string): "reported" | "observed" | undefined {
  if (targetState === "") return undefined;
  return targetState === "observed-quiet" ? "observed" : "reported";
}
