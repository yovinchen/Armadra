import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Share2 } from "lucide-react";

import { runtimeApi } from "@/api/client";
import { onWorkspaceEvent } from "@/api/events";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { Badge } from "@/ui/badge";
import { isSettled } from "./HandoffDialog";
import { openHandoff } from "./handoff-targets";

/**
 * 节点头部的交接标记（design §7.3 第 6 条）。
 *
 * 「画布上的交接关联」复用已有的连线：交接本来就要求源和目标之间存在一条
 * 上下文链接，那条 `link` 边**就是**关联，所以这里不新增边、不新增 shape，
 * 更不会在用户删掉边之后偷偷补回来——删边等于收回上下文权限，Runtime 那边
 * 也会因此拒绝投递。这个 chip 只是把「这条边上有一次进行中的交接」显示出来，
 * 点一下打开同一个对话框查看那份包。
 *
 * 只显示尚未落定的交接。已确认 / 已撤回 / 已过期的记录不该常驻在头部。
 */
export function HandoffBadge({ nodeId }: { nodeId: string }) {
  const t = useT();
  const client = useQueryClient();
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const key = React.useMemo(
    () => ["handoffs", workspaceId, nodeId],
    [workspaceId, nodeId],
  );
  const query = useQuery({
    queryKey: key,
    enabled: workspaceId !== null,
    queryFn: ({ signal }) => runtimeApi.handoffs(workspaceId!, nodeId, signal),
    retry: false,
    staleTime: Infinity,
  });
  React.useEffect(
    () =>
      onWorkspaceEvent("agent.delivery", (event) => {
        if (event.sourceNodeId !== nodeId && event.targetNodeId !== nodeId)
          return;
        void client.invalidateQueries({ queryKey: key });
      }),
    [client, key, nodeId],
  );

  const active = (query.data ?? []).find((view) => !isSettled(view.state));
  if (!active) return null;
  return (
    <Badge
      asChild
      variant="outline"
      className="h-[18px] cursor-pointer px-1.5 text-[length:var(--text-caption)]"
    >
      <button
        type="button"
        title={t(`handoff.${active.state}`)}
        onClick={() =>
          openHandoff({
            nodeId,
            sessionId: active.bundle.source.sessionId,
            generation: active.bundle.source.generation,
            handoffId: active.bundle.handoffId,
          })
        }
      >
        <Share2 className="size-2.5" />
        <span className="truncate">{t(`handoff.${active.state}`)}</span>
      </button>
    </Badge>
  );
}
