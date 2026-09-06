import type { LucideIcon } from "lucide-react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Group,
  Maximize2,
  Minimize2,
  Trash2,
  Ungroup,
  Unlink,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { CanvasNode, CanvasNodeType } from "@armadra/shared";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/ui/context-menu";
import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { frameBindingOf } from "../frame-binding";
import { runCanvasCommand } from "../commands";
import { ReferenceSubmenu } from "./reference-menu";

/**
 * 节点右键菜单（§3.2）。
 *
 * 通用项在这里；Agent 专属项（重启 Agent / 切换权限模式 / 恢复会话）由
 * nodes agent 通过 `registerNodeMenuItems` 追加，插在「最大化」与「删除」
 * 之间——canvas 不认识 Agent 生命周期，nodes 不该重写整份菜单。
 */

export interface NodeMenuContext {
  node: CanvasNode;
  /** 右键命中的节点若在选区里，动作作用于整个选区；否则只作用于它自己。 */
  targetIds: string[];
}

export interface NodeMenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
  destructive?: boolean;
  run: () => void;
}

export type NodeMenuItemsFactory = (context: NodeMenuContext) => NodeMenuItem[];

const extraItems = new Map<CanvasNodeType, Set<NodeMenuItemsFactory>>();

/**
 * 给某种节点追加右键菜单项。返回注销函数（模块顶层注册一次即可）。
 *
 * ```ts
 * registerNodeMenuItems("terminal", ({ node }) => [
 *   { id: "agent.restart", label: "重启 Agent", icon: RotateCcw, run: () => … },
 * ]);
 * ```
 */
export function registerNodeMenuItems(
  type: CanvasNodeType,
  factory: NodeMenuItemsFactory,
): () => void {
  const set = extraItems.get(type) ?? new Set<NodeMenuItemsFactory>();
  set.add(factory);
  extraItems.set(type, set);
  return () => {
    set.delete(factory);
  };
}

export function nodeMenuExtras(context: NodeMenuContext): NodeMenuItem[] {
  const factories = extraItems.get(context.node.type);
  if (!factories) return [];
  return [...factories].flatMap((factory) => factory(context));
}

/** 仅测试用。 */
export function clearNodeMenuItems() {
  extraItems.clear();
}

/* -------------------------------------------------------------------------- */

/**
 * 菜单体。调用方套 `<ContextMenuContent>`，与新建菜单一致。
 */
export function NodeMenuContent({ node }: { node: CanvasNode }) {
  const t = useT();
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  // `useShallow` 是必需的：选择器每次都 `filter` 出一个新数组，zustand v5 的
  // `useSyncExternalStore` 按 `Object.is` 比，不加就是「快照没缓存」的无限
  // 重渲染——右键任何一个节点，整个应用白屏。
  const groups = useCanvasStore(
    useShallow((state) =>
      (state.document?.nodes ?? []).filter((item) => item.type === "group"),
    ),
  );
  const maximized = useCanvasStore(
    (state) => state.maximized[node.id] !== undefined,
  );

  const targetIds = selectedNodeIds.includes(node.id)
    ? selectedNodeIds
    : [node.id];
  const context: NodeMenuContext = { node, targetIds };
  const extras = nodeMenuExtras(context);
  const store = useCanvasStore.getState;
  /**
   * 画布级命令（分组 / 最大化 / 删除）作用于选区，所以先把右键命中的
   * 节点同步进选区，再触发命令——否则在未选中的节点上右键删除会删错。
   */
  const onTargets = (id: Parameters<typeof runCanvasCommand>[0]) => () => {
    store().selectNodes(targetIds);
    runCanvasCommand(id);
  };
  const joinable = groups.filter(
    (group) => !targetIds.includes(group.id) && group.id !== node.parentId,
  );

  return (
    <>
      {node.type === "group" ? null : (
        <ContextMenuItem onSelect={onTargets("canvas.group")}>
          <Group />
          {t("node.group")}
        </ContextMenuItem>
      )}

      {joinable.length > 0 && node.type !== "group" ? (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Group />
            {t("node.joinGroup")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {joinable.map((group) => (
              <ContextMenuItem
                key={group.id}
                onSelect={() => store().setParent(targetIds, group.id)}
              >
                <span className="truncate">{group.title}</span>
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      ) : null}

      {node.parentId ? (
        <ContextMenuItem onSelect={() => store().setParent(targetIds, null)}>
          <Ungroup />
          {t("node.leaveGroup")}
        </ContextMenuItem>
      ) : null}

      <ContextMenuItem onSelect={() => store().duplicateNodes(targetIds)}>
        <Copy />
        {t("node.duplicate")}
      </ContextMenuItem>

      <ContextMenuItem
        onSelect={() => {
          const collapsed = !(node.collapsed ?? false);
          for (const id of targetIds) store().setCollapsed(id, collapsed);
        }}
      >
        {node.collapsed ? <ChevronDown /> : <ChevronRight />}
        {node.collapsed ? t("node.expand") : t("node.collapse")}
      </ContextMenuItem>

      {node.type === "group" ? (
        // Frame 可以当引用来源：引用它 = 引用它圈住的那一片
        // （`canvas/frame-reference.ts`）。白板对象那条路在 `item-menu.tsx`。
        <ReferenceSubmenu sourceId={node.id} />
      ) : null}

      {frameBindingOf(node) ? (
        // 解绑只清 `data.binding`，磁盘上的 checkout 一个字节都不动；
        // 删 checkout 只有仓库面板那条安全移除（G03）。
        <ContextMenuItem
          onSelect={() => store().updateNodeData(node.id, { binding: null })}
        >
          <Unlink />
          {t("frameBinding.unbindFrame")}
        </ContextMenuItem>
      ) : null}

      <ContextMenuItem
        onSelect={onTargets(maximized ? "canvas.restore" : "canvas.maximize")}
      >
        {maximized ? <Minimize2 /> : <Maximize2 />}
        {maximized ? t("node.restore") : t("node.maximize")}
      </ContextMenuItem>

      {extras.length > 0 ? <ContextMenuSeparator /> : null}
      {extras.map((item) => {
        const Icon = item.icon;
        return (
          <ContextMenuItem
            key={item.id}
            disabled={item.disabled}
            variant={item.destructive ? "destructive" : "default"}
            onSelect={item.run}
          >
            {Icon ? <Icon /> : null}
            <span className="truncate">{item.label}</span>
          </ContextMenuItem>
        );
      })}

      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onSelect={onTargets("canvas.delete")}
      >
        <Trash2 />
        {t("node.delete")}
      </ContextMenuItem>
    </>
  );
}
