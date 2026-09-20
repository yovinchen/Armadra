/**
 * 「排队 N」——排在这个终端前面的那些（设计 `agent-delivery.md` §4.6、§10）。
 *
 * 排在别人终端前面的东西，被排队的那个人要能看见；看得见还不够，他对自己的
 * 终端有最终决定权，所以每一条都能当场拒收。
 *
 * **数字不由页面自己加减。** `agent.delivery` 只说「这个节点的队伍动了」，
 * 真正的计数从 core 重读——队列会因为出队、取消、过期三种原因变短，页面按
 * 事件推算迟早会与那张表说两个数。空队列不画任何东西：没有人排队是常态。
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
      </PopoverContent>
    </Popover>
  );
}
