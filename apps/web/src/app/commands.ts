import { useCallback, useMemo } from "react";
import type { Position } from "@ai-coding-canvas/shared";
import { buildAddMenu, type AddMenuItem } from "../canvas/menus/add-menu";
import { runCanvasCommand } from "../canvas/commands";
import { screenToPage } from "../canvas/editor-context";
import { COMMAND_BY_ID, type CommandId } from "../keybindings";
import { useT } from "./preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { useEnabledAgents } from "./use-agents";

/** 源码控制抽屉监听它来触发提交（⌘⏎，§13.5）。 */
export const SCM_COMMIT_EVENT = "aicc:scm-commit";

export interface CommandDispatch {
  /** 执行一条命令；快捷键、命令面板、菜单三处共用。 */
  run: (id: CommandId) => void;
  /** 当前可用的新建菜单项（已按设置过滤掉禁用的 Agent）。 */
  addMenuItems: AddMenuItem[];
  /** 视口中心的画布坐标，新建节点默认落在这里。 */
  centerPosition: () => Position;
}

/**
 * 应用级命令派发（§13.5）。
 *
 * 分三类：`app` 作用域自己处理面板开关；`canvas` 作用域转发给
 * `canvas/commands.ts` 的注册表；`scm.commit` 打开抽屉后广播一个事件，
 * 因为提交框的内容只有抽屉自己知道。
 */
export function useCommandDispatch(): CommandDispatch {
  const agents = useEnabledAgents();
  const t = useT();
  const addMenuItems = useMemo(() => buildAddMenu(agents, t), [agents, t]);

  // 画布外的模块只经 `editor-context` 拿 editor（§9.1）；画布没挂载时
  // `screenToPage` 原样返回屏幕坐标，节点仍然落在一个合理的位置。
  const centerPosition = useCallback(
    () =>
      screenToPage({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      }),
    [],
  );

  const run = useCallback(
    (id: CommandId) => {
      const state = useCanvasStore.getState();
      const { panels, setPanel } = state;

      switch (id) {
        case "app.commandPalette":
          setPanel("palette", !panels.palette);
          return;
        case "app.settings":
          setPanel("settings", !panels.settings);
          return;
        case "app.sidebar":
          setPanel("sidebar", panels.sidebar === "open" ? "collapsed" : "open");
          return;
        case "app.explorer":
          setPanel(
            "explorer",
            panels.explorer === "closed" ? "drawer" : "closed",
          );
          return;
        case "app.sourceControl":
          setPanel("scm", panels.scm === "closed" ? "drawer" : "closed");
          return;
        case "canvas.focusMode": {
          const next = state.focusNodeId
            ? null
            : (state.selectedNodeIds[0] ?? null);
          state.setFocusNode(next);
          return;
        }
        case "scm.commit":
          setPanel("scm", "drawer");
          window.dispatchEvent(new CustomEvent(SCM_COMMIT_EVENT));
          return;
        default:
          break;
      }

      // 新建类命令由新建菜单自己实现（同一份菜单规格驱动三个入口，§3.2）
      const item = addMenuItems.find((entry) => entry.shortcut === id);
      if (item && state.workspace) {
        item.run({
          addNode: state.addNode,
          position: centerPosition(),
          workspace: state.workspace,
          agents,
        });
        return;
      }

      // 其余（撤销/重做/整理/删除/最大化/几何切换/终端搜索）归画布
      if (COMMAND_BY_ID[id].scope !== "app") runCanvasCommand(id);
    },
    [addMenuItems, agents, centerPosition],
  );

  return { run, addMenuItems, centerPosition };
}
