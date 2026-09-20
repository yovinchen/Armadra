import type { DriveLease } from "@armadra/shared";

import { useDriveStore } from "@/agent/drive-store";
import { terminalsApi } from "@/api/terminals";
import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";

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
export function DriveBadge({
  nodeId,
  sessionId,
}: {
  nodeId: string;
  /** 接管与交还的对象是那个 PTY，不是节点；没有会话就只剩徽标。 */
  sessionId?: string | null;
}) {
  const t = useT();
  // 状态只从 `terminal.lease` 来，而那份镜像是全局的一份（`agent/drive-store`）：
  // 节点头与命令面板读同一个答案，不各自订阅、各自记一份。
  const lease = useDriveStore((state) => state.drives[nodeId]?.lease);

  const label = driveLabel(lease);
  if (label === undefined) return null;
  const action = driveAction(lease);
  return (
    <>
      <Badge
        variant={lease?.state === "agent" ? "default" : "outline"}
        className="h-[18px] px-1.5 text-[length:var(--text-caption)]"
        data-slot="terminal-driver"
        title={t(label.key, { name: label.name })}
      >
        <span className="truncate">{t(label.key, { name: label.name })}</span>
      </Badge>
      {/*
        接管 / 交还（§6.1）。按钮挨着那句话，因为它回答的正是那句话提出的
        问题：「Agent 在驱动」之后人唯一想做的事就是把键盘拿回来。没有会话
        时不画——租约的对象是那个 PTY。
      */}
      {action !== undefined && sessionId ? (
        <Button
          size="xs"
          variant="ghost"
          data-no-drag="true"
          data-slot="terminal-drive-action"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            // 徽标不读这次的答复：那一帧 `terminal.lease` 会到每一台看着这块
            // 画布的设备上，自己先翻一次只会让两台设备短暂地说两句话。
            void terminalsApi.driveTerminal(sessionId, action);
          }}
        >
          {t(
            action === "takeover"
              ? "terminal.drive.take"
              : "terminal.drive.giveBack",
          )}
        </Button>
      ) : null}
    </>
  );
}

/**
 * 这一刻人能做的那件事。`undefined` 表示不画按钮。
 *
 * 人自己抢占着（`human`）也给「交还」：那是他十秒之内会自己失去的租约，但在
 * 那十秒里他可能已经做完了，而等十秒不是一个动作。
 */
export function driveAction(
  lease: DriveLease | undefined,
): "takeover" | "release" | undefined {
  if (lease === undefined) return undefined;
  if (lease.state === "agent") return "takeover";
  if (lease.state === "human" || lease.state === "humanTakeover")
    return "release";
  return undefined;
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
