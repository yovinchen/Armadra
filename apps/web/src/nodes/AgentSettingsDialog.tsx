/**
 * 终端节点的 Agent 设置（设计 `agent-delivery.md` §10「节点设置」那一行）。
 *
 * 三件事，都是「别人对我这个节点能做什么」：
 *
 *   * **收件箱唤醒**（§5）：空闲时有未读，什么都不做 / 推一行提示 / 直接投进来。
 *     缺省是提示——`post` 今天的失效方式不是提示太吵，是没有人来读。
 *   * **允许从向我投递**（§2.6）：默认关。一条「我监督你」的线不是反向也能
 *     写进来的理由。
 *   * **允许相连 Agent 读取转录**（阶段 C+）：默认开；关掉之后对方只拿得到
 *     一份 ≤2 KB 的摘要。
 *
 * 写入一律走 canvas-store 的 `updateNodeData`：节点数据只有一个写口，改完跟
 * 着画布文档一起保存、一起同步到别的窗口。
 */
import * as React from "react";
import {
  INBOX_WAKE_MODES,
  type CanvasNode,
  type InboxWake,
} from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Switch } from "@/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { useCanvasStore } from "@/store/canvas-store";
import { onAgentSettingsRequest } from "./agent-settings";

/** 与 core 的 `DEFAULT_INBOX_WAKE` 同值（`core/collab/wake.ts`）。 */
const DEFAULT_INBOX_WAKE: InboxWake = "notify";

export function AgentSettingsDialog() {
  const t = useT();
  const [nodeId, setNodeId] = React.useState<string | null>(null);
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);

  React.useEffect(() => onAgentSettingsRequest((id) => setNodeId(id)), []);

  const node: CanvasNode | undefined = (nodes ?? []).find(
    (entry) => entry.id === nodeId,
  );
  const agent = node?.data.kind === "terminal" ? node.data.agent : undefined;

  const close = (): void => setNodeId(null);

  /** 三项都改同一个 `agent` 对象，所以补丁在一个地方拼。 */
  const patch = (next: Record<string, unknown>): void => {
    if (node === undefined || agent === undefined) return;
    updateNodeData(node.id, { agent: { ...agent, ...next } } as never);
  };

  const wake = agent?.inboxWake ?? DEFAULT_INBOX_WAKE;

  return (
    <Dialog
      open={agent !== undefined}
      onOpenChange={(open) => !open && close()}
    >
      <DialogContent className="z-[var(--z-dialog)]">
        <DialogHeader>
          <DialogTitle>{t("agentSettings.title")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--muted-foreground)]">
              {t("agentSettings.inboxWake")}
            </span>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={wake}
              aria-label={t("agentSettings.inboxWake")}
              onValueChange={(next) => {
                if (!(INBOX_WAKE_MODES as readonly string[]).includes(next)) {
                  return;
                }
                patch({ inboxWake: next as InboxWake });
              }}
            >
              {INBOX_WAKE_MODES.map((mode) => (
                <ToggleGroupItem key={mode} value={mode}>
                  {t(`agentSettings.inboxWake.${mode}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <label className="flex items-center justify-between gap-3 text-sm">
            {t("agentSettings.acceptSubDelivery")}
            <Switch
              checked={agent?.acceptSubDelivery === true}
              aria-label={t("agentSettings.acceptSubDelivery")}
              onCheckedChange={(next) => patch({ acceptSubDelivery: next })}
            />
          </label>

          {/*
            关掉之后对方拿到的是摘要而不是转录，所以「关」不是「读不到」——
            开关的两端都是一句完整的话（`contextShare`: full / summary）。
          */}
          <label className="flex items-center justify-between gap-3 text-sm">
            {t("agentSettings.contextShare")}
            <Switch
              checked={(agent?.contextShare ?? "full") === "full"}
              aria-label={t("agentSettings.contextShare")}
              onCheckedChange={(next) =>
                patch({ contextShare: next ? "full" : "summary" })
              }
            />
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
