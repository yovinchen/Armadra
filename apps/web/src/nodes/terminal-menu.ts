import { KeyRound, Recycle, RotateCcw, Tag } from "lucide-react";
import {
  PERMISSION_MODES,
  type PermissionMode,
} from "@armadra/shared";

import {
  registerNodeMenuItems,
  type NodeMenuItem,
} from "@/canvas/menus/node-menu";
import { useCanvasStore } from "@/store/canvas-store";
import { permissionModeLabel } from "@/agent/launch";
import { t } from "@/app/preferences-store";
import { openNodeAnnotation } from "@/meta/annotations";
import { terminalHandle } from "./terminal-registry";

/**
 * 终端节点的 Agent 专属右键菜单项（§3.2）。
 *
 * canvas 的注册表只支持平铺项（没有子菜单），所以「权限模式」摊成四条，
 * 当前模式那条置灰——这样一眼看得出现在是哪种模式，也不用再开一层。
 *
 * 切模式后必须重启：权限是启动行上的参数，改数据不改已经在跑的进程。
 */
let dispose: (() => void) | null = null;

export function registerTerminalNodeMenu(): () => void {
  // 幂等：模块加载时自动调一次，测试里再调也不会注册两份。
  if (dispose) return dispose;
  dispose = registerNodeMenuItems("terminal", ({ node }) => {
    if (node.data.kind !== "terminal") return [];
    // 「标签…」对所有终端都有（§17）：终端头部不许再多一行，标签只有这一个
    // 编辑入口，编辑结果显示在看板卡片上。
    const labels: NodeMenuItem = {
      id: "node.labels",
      label: `${t("meta.labels")}…`,
      icon: Tag,
      run: () => openNodeAnnotation(node.id, "labels"),
    };
    const agent = node.data.agent;
    if (!agent) return [labels];

    const current: PermissionMode = agent.permissionMode ?? "default";
    const items: NodeMenuItem[] = [
      labels,
      {
        id: "agent.restart",
        label: t("agent.restart"),
        icon: RotateCcw,
        run: () => terminalHandle(node.id)?.restart(),
      },
      {
        id: "agent.recycle",
        label: t("agent.recycle"),
        icon: Recycle,
        run: () => terminalHandle(node.id)?.recycle(),
      },
    ];

    for (const mode of PERMISSION_MODES) {
      items.push({
        id: `agent.permission.${mode}`,
        label: `${t("agent.permissionMode")} · ${permissionModeLabel(mode)}`,
        icon: KeyRound,
        disabled: mode === current,
        run: () => {
          useCanvasStore.getState().updateNodeData(node.id, {
            agent: { ...agent, permissionMode: mode },
          });
          terminalHandle(node.id)?.restart();
        },
      });
    }

    return items;
  });
  return dispose;
}

/** 模块加载即注册一次；`TerminalNode` 以副作用方式引入本文件。 */
registerTerminalNodeMenu();
