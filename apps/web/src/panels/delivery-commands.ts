/**
 * 命令面板里对着**一个具体终端**说的那几条（设计 `agent-delivery.md` §10）。
 *
 * 为什么不进 `COMMANDS` 那张全局表：那张表里的每一条在任何时候都成立，而这三
 * 条都有一个主语——没有选中终端节点时「接管谁的终端」没有答案。所以它们按选中
 * 项现算，选中的不是终端就一条都不出。
 *
 * 「查看队列」打开的是节点头上已经有的那个浮层，不另画一份列表：两份列表就会
 * 有两份「取消」，也就会有两种行为。
 */
import type { CanvasNode } from "@armadra/shared";

import { requestDeliveryQueue } from "@/agent/delivery-store";
import { useDriveStore, type NodeDrive } from "@/agent/drive-store";
import { terminalsApi } from "@/api/terminals";
import { requestCenterOnNode } from "@/canvas/flow/flow-context";
import { useCanvasStore } from "@/store/canvas-store";

export interface NodeCommand {
  readonly id: string;
  readonly label: string;
  run: () => void;
}

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export interface TerminalCommandInput {
  readonly node: CanvasNode | undefined;
  /** 这个节点的会话与租约；没有会话就只剩「看队列」。 */
  readonly drive: NodeDrive | undefined;
  readonly t: Translate;
}

/**
 * 这一刻选中的终端节点能做的那几件事。
 *
 * 接管与交还是**互斥**的两条，而不是一条带开关的：菜单里同时列出「接管」与
 * 「交还」会让人先想一下现在是哪种，而那个答案徽标上已经写着了。
 */
export function terminalNodeCommands(
  input: TerminalCommandInput,
): NodeCommand[] {
  const { node, drive, t } = input;
  if (node === undefined || node.type !== "terminal") return [];
  const title = node.title;
  const commands: NodeCommand[] = [
    {
      id: "delivery.queue",
      label: t("delivery.palette.queue", { title }),
      run: () => {
        useCanvasStore.getState().selectNodes([node.id]);
        requestCenterOnNode(node.id);
        requestDeliveryQueue(node.id);
      },
    },
  ];
  const sessionId = drive?.sessionId;
  const state = drive?.lease.state;
  if (sessionId === undefined) return commands;
  if (state === "human" || state === "humanTakeover") {
    commands.push({
      id: "delivery.release",
      label: t("delivery.palette.release", { title }),
      run: () => void terminalsApi.driveTerminal(sessionId, "release"),
    });
  } else {
    commands.push({
      id: "delivery.takeover",
      label: t("delivery.palette.takeover", { title }),
      run: () => void terminalsApi.driveTerminal(sessionId, "takeover"),
    });
  }
  return commands;
}

/** 面板里取一次：选中项 + 它此刻的租约。 */
export function useTerminalNodeCommands(t: Translate): NodeCommand[] {
  const selected = useCanvasStore((state) => state.selectedNodeIds);
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const nodeId = selected.length === 1 ? selected[0] : undefined;
  const node = nodes?.find((entry) => entry.id === nodeId);
  const drive = useDriveStore((state) =>
    nodeId === undefined ? undefined : state.drives[nodeId],
  );
  return terminalNodeCommands({ node, drive, t });
}
