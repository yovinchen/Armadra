import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { ArrowRight, X } from "lucide-react";
import type { AgentDelivery } from "@armadra/shared";

import { runtimeApi } from "../api/client";
import { onWorkspaceEvent } from "../api/events";
import { useT } from "../app/preferences-store";
import { formatRelativeTime } from "../lib/format";
import { useCanvasStore } from "../store/canvas-store";
import { Badge } from "../ui/badge";
import { IconButton } from "../ui/icon-button";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet";

/**
 * 投递记录（§5.7 第 10 条）。
 *
 * 数据来自 `GET /api/workspaces/{id}/deliveries`（Runtime 的 `agent_deliveries`
 * 表，与 `<workspace>/.armadra/board-log.jsonl` 同源），再用 `agent.delivery`
 * 事件实时追加——这样刚投出去的一条不必等下一次轮询才出现。
 *
 * **正文从来不在这里**：Runtime 只记 `bodyChars`。这不是省事，是设计：
 * 投递日志是给人看「谁给谁发过、结果如何」的，不是消息存档。
 */

interface DeliveryLogState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/**
 * 面板的开关。放在自己的 store 里而不是 `canvas-store.panels`：
 * 那份 `panels` 的键集合是 §13.1 的跨模块契约，不该为一个次要面板扩容。
 */
export const useDeliveryLogStore = create<DeliveryLogState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function openDeliveryLog(): void {
  useDeliveryLogStore.getState().setOpen(true);
}

/** 结果 → 语气。可重试的按「等待」处理，终局失败才是红的。 */
export function outcomeTone(outcome: string): "ok" | "pending" | "failed" {
  if (outcome === "delivered") return "ok";
  if (outcome === "queued") return "pending";
  return "failed";
}

/**
 * 结果的中文名。判别联合会随 Runtime 增加成员，缺键时显示原始字符串
 * 比显示 `delivery.outcome.somethingNew` 有用。
 */
export function outcomeLabel(
  translate: (key: string) => string,
  outcome: string,
): string {
  const key = `delivery.outcome.${outcome}`;
  const label = translate(key);
  return label === key ? outcome : label;
}

const TONE_COLOR: Record<"ok" | "pending" | "failed", string> = {
  ok: "var(--success)",
  pending: "var(--warn)",
  failed: "var(--danger)",
};

/** 事件帧 → 一行（服务端那份会在下一次拉取时覆盖它）。 */
export function rowFromEvent(
  workspaceId: string,
  event: {
    traceId: string;
    sourceNodeId: string;
    targetNodeId: string;
    outcome: string;
  },
  now = new Date(),
): AgentDelivery {
  return {
    traceId: event.traceId,
    workspaceId,
    sourceNodeId: event.sourceNodeId,
    targetNodeId: event.targetNodeId,
    outcome: event.outcome,
    bodyChars: 0,
    createdAt: now.toISOString(),
  };
}

/** 事件行在前，重复的 `traceId` 只留一份。 */
export function mergeDeliveries(
  live: readonly AgentDelivery[],
  fetched: readonly AgentDelivery[],
): AgentDelivery[] {
  const seen = new Set<string>();
  const out: AgentDelivery[] = [];
  for (const row of [...live, ...fetched]) {
    if (seen.has(row.traceId)) continue;
    seen.add(row.traceId);
    out.push(row);
  }
  return out;
}

export function DeliveryLog() {
  const t = useT();
  const open = useDeliveryLogStore((state) => state.open);
  const setOpen = useDeliveryLogStore((state) => state.setOpen);
  const workspace = useCanvasStore((state) => state.workspace);
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const workspaceId = workspace?.id ?? null;
  const [live, setLive] = useState<AgentDelivery[]>([]);

  const query = useQuery({
    queryKey: ["deliveries", workspaceId],
    queryFn: () => runtimeApi.deliveries(workspaceId!),
    enabled: open && Boolean(workspaceId),
    retry: false,
  });

  // 订阅一直挂着（面板关着也在收），打开时不必等一次往返。
  useEffect(() => {
    if (!workspaceId) return;
    setLive([]);
    return onWorkspaceEvent("agent.delivery", (event) => {
      setLive((current) =>
        [rowFromEvent(workspaceId, event), ...current].slice(0, 200),
      );
    });
  }, [workspaceId]);

  const rows = useMemo(
    () => mergeDeliveries(live, query.data ?? []),
    [live, query.data],
  );

  const titleOf = (nodeId: string) =>
    nodes?.find((node) => node.id === nodeId)?.title ?? nodeId.slice(0, 8);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        className="w-[460px] gap-0 p-0 sm:max-w-none"
      >
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
          <SheetTitle className="truncate text-[length:var(--text-body)] font-semibold">
            {t("delivery.title")}
          </SheetTitle>
          <div className="flex-1" />
          <IconButton
            label={t("delivery.close")}
            onClick={() => setOpen(false)}
          >
            <X />
          </IconButton>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {rows.length === 0 ? (
            <p className="px-4 py-3 text-[length:var(--text-body)] text-muted-foreground">
              {t("delivery.empty")}
            </p>
          ) : (
            <ul className="flex flex-col p-1">
              {rows.map((row) => {
                const tone = outcomeTone(row.outcome);
                return (
                  <li
                    key={row.traceId}
                    className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 hover:bg-muted"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[length:var(--text-body)]">
                        {titleOf(row.sourceNodeId)}
                      </span>
                      <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
                      <span className="truncate text-[length:var(--text-body)]">
                        {titleOf(row.targetNodeId)}
                      </span>
                      <Badge
                        variant="outline"
                        className="ml-auto shrink-0"
                        style={{
                          color: TONE_COLOR[tone],
                          borderColor: TONE_COLOR[tone],
                        }}
                      >
                        {outcomeLabel(t, row.outcome)}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 text-[length:var(--text-caption)] text-muted-foreground">
                      <span>{formatRelativeTime(row.createdAt)}</span>
                      {row.bodyChars > 0 && (
                        <span className="tabular-nums">
                          {t("delivery.chars", { count: row.bodyChars })}
                        </span>
                      )}
                      {row.receipt && <span>{row.receipt}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
