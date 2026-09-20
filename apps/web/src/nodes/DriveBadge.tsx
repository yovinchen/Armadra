import * as React from "react";
import type { DriveLease } from "@armadra/shared";

import { onWorkspaceEvent } from "@/api/events";
import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";

/**
 * 谁在驱动这个终端（设计 `agent-delivery.md` §6）。
 *
 * 浏览器节点早就有这个徽标，终端节点没有，于是「一个 Agent 正在替我按键」这件
 * 事在界面上完全看不见。这里补上同一句话的终端版本，用的是同一套词汇：人敲一个
 * 键就抢占，停手十秒自然过期，显式接管一直持有到交还。
 *
 * 状态只从 `terminal.lease` 事件来，不按「我刚才敲过」推断——两台设备看着同一个
 * 终端时，各自推断的结果会是两个不同的答案。
 *
 * 空闲不画任何东西：节点头只留「一眼就要看到」的那几样，而「没有人在驱动」是
 * 常态，把它画出来只是噪音。
 */
export function DriveBadge({ nodeId }: { nodeId: string }) {
  const t = useT();
  const [lease, setLease] = React.useState<DriveLease | undefined>();

  React.useEffect(() => {
    setLease(undefined);
    return onWorkspaceEvent("terminal.lease", (event) => {
      if (event.nodeId !== nodeId) return;
      setLease(event.lease);
    });
  }, [nodeId]);

  // 会话没了就没有「谁在驱动」这回事：租约的对象是那个 PTY。
  React.useEffect(
    () =>
      onWorkspaceEvent("terminal.exit", (event) => {
        if (event.nodeId !== nodeId) return;
        setLease(undefined);
      }),
    [nodeId],
  );

  const label = driveLabel(lease);
  if (label === undefined) return null;
  return (
    <Badge
      variant={lease?.state === "agent" ? "default" : "outline"}
      className="h-[18px] px-1.5 text-[length:var(--text-caption)]"
      data-slot="terminal-driver"
      title={t(label.key, { name: label.name })}
    >
      <span className="truncate">{t(label.key, { name: label.name })}</span>
    </Badge>
  );
}

/**
 * 徽标上那句话。`undefined` 表示不画。
 *
 * Agent 用它的名字，没有名字退回节点 id——阶段 A 起 `handle` 才是那个名字，在
 * 那之前退回去的那个 id 至少是稳定的、能对上画布的。
 */
export function driveLabel(
  lease: DriveLease | undefined,
): { key: string; name: string } | undefined {
  if (lease === undefined || lease.state === "free" || !lease.holder) {
    return undefined;
  }
  if (lease.holder.kind === "agent") {
    return {
      key: "terminal.drive.agent",
      name: lease.holder.displayName || lease.holder.id,
    };
  }
  return {
    key:
      lease.state === "humanTakeover"
        ? "terminal.drive.takeover"
        : "terminal.drive.you",
    name: lease.holder.displayName,
  };
}
