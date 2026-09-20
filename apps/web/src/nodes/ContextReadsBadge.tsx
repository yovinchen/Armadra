/**
 * 「被读取 N 次」——谁读过这个节点的转录（设计 `agent-delivery.md` §10）。
 *
 * 读是单向可见的：相连的 Agent 读走一份摘要，读的人知道，被读的人不知道。
 * 这个徽标补上另一半，配合节点设置里的「允许相连 Agent 读取转录」——一个说
 * 「能不能读」，一个说「读过几次」，缺了后者，前者那个开关没有任何可依据的
 * 事实。
 *
 * 三条规矩：
 *
 *   * **没人读过就不画。** 节点头只留一眼要看到的那几样，`0 次`是常态。
 *   * **数字来自 core。** 页面不按事件累加——审计表才是那份账。
 *   * **core 还没就绪就当没有这件事。** 404 / 501 不报错、不提示，徽标不画：
 *     一个还没实现的读取审计不是用户要处理的故障。
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye } from "lucide-react";

import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { usePageVisible } from "@/panels/resources/use-visibility";
import { Badge } from "@/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

/** 悬停里最多几条。再多就不是「最近」了，那是审计面板的事。 */
const RECENT_SHOWN = 5;

export function ContextReadsBadge({
  nodeId,
  visible,
}: {
  nodeId: string;
  /** 节点自己知道的可见性：折叠 / 已退出的节点不轮询。 */
  visible: boolean;
}) {
  const t = useT();
  const pageVisible = usePageVisible();
  const watched = visible && pageVisible;
  const [open, setOpen] = React.useState(false);

  const reads = useQuery({
    queryKey: ["context-reads", nodeId],
    queryFn: ({ signal }) => runtimeApi.contextReads(nodeId, signal),
    staleTime: 30_000,
    // 看不见就不问：一个折叠的节点上没有人在看这个数字。
    refetchInterval: watched ? 30_000 : false,
    refetchOnWindowFocus: watched,
    // core 没这条路径时答 404 / 501，重试只是把同一个答案再要四遍。
    retry: false,
  });

  const total = reads.data?.total ?? 0;
  if (reads.isError || total === 0) return null;
  const recent = (reads.data?.recent ?? []).slice(0, RECENT_SHOWN);

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
            data-slot="context-reads"
            data-testid={`context-reads-${nodeId}`}
            aria-label={t("contextReads.count", { count: total })}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
          >
            <Eye className="size-2.5" />
            {t("contextReads.count", { count: total })}
          </button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 max-w-[calc(100vw-1rem)] text-xs"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h3 className="font-medium">{t("contextReads.title")}</h3>
        {recent.length === 0 ? (
          <p className="text-muted-foreground">{t("contextReads.empty")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {recent.map((entry) => (
              <li
                key={`${entry.readerNodeId}-${entry.atMs}`}
                className="min-w-0 truncate"
              >
                {t("contextReads.entry", {
                  name: entry.readerName ?? entry.readerNodeId,
                  verb: entry.verb,
                  bytes: formatBytes(entry.bytes),
                })}
                <span className="block truncate text-muted-foreground">
                  {formatRelativeTime(entry.atMs)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
