import type { ReactNode } from "react";

import { useT } from "../../../../app/preferences-store";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../../../../ui/context-menu";
import type { BranchTreeNode } from "../build-tree";
import type { MenuContext } from "./context";
import {
  refMenuItems,
  type RefMenuIntent,
  type RefMenuItem,
} from "./ref-items";

/**
 * 分支树节点的右键菜单。
 *
 * 这里只画：项目、禁用、分隔线、子菜单都由 `ref-items.ts` 算好。组件因此没有
 * 一句「什么时候能删」的判断，也就不会和单测钉住的那份判断分叉。
 */

export function BranchContextMenu({
  node,
  context,
  children,
}: {
  node: BranchTreeNode;
  context: MenuContext;
  children: ReactNode;
}) {
  const repository = node.repositoryPath;
  const items = refMenuItems({
    node,
    remotes: repository ? context.remotes(repository) : [],
    currentBranch: repository ? context.currentBranch(repository) : null,
    stateToken: repository ? context.stateToken(repository) : null,
    idle: repository ? context.idle(repository) : false,
    busy: context.busy,
  });
  if (items.length === 0) return <>{children}</>;

  const run = (item: RefMenuItem) => {
    if (item.action && repository) context.request(repository, item.action);
    if (item.intent) dispatch(item.intent, context);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        {(node.reference || node.kind === "remote") && (
          <ContextMenuLabel className="truncate">
            {node.reference ?? node.label}
          </ContextMenuLabel>
        )}
        {items.map((item) => (
          <Row key={item.id} item={item} onSelect={run} />
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Row({
  item,
  onSelect,
}: {
  item: RefMenuItem;
  onSelect: (item: RefMenuItem) => void;
}) {
  const t = useT();
  const text = item.labelKey ? t(item.labelKey) : (item.label ?? "");
  if (item.children) {
    return (
      <>
        {item.separated && <ContextMenuSeparator />}
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={item.disabled}>
            {text}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-72 overflow-auto">
            {item.children.map((child) => (
              <Row key={child.id} item={child} onSelect={onSelect} />
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </>
    );
  }
  return (
    <>
      {item.separated && <ContextMenuSeparator />}
      <ContextMenuItem
        data-menu-item={item.id}
        variant={item.destructive ? "destructive" : "default"}
        disabled={item.disabled}
        onSelect={() => onSelect(item)}
      >
        {text}
      </ContextMenuItem>
    </>
  );
}

function dispatch(intent: RefMenuIntent, context: MenuContext) {
  switch (intent.kind) {
    case "prompt":
      context.onPrompt(intent.prompt);
      return;
    case "reflog":
      context.onReflog(intent.repositoryPath);
      return;
    case "stashDiff":
      context.onStashDiff({
        repositoryPath: intent.repositoryPath,
        oid: intent.oid,
      });
      return;
    case "worktreeFrame":
      context.onWorktreeFrame({ path: intent.path, branch: intent.branch });
      return;
    case "favorite":
      context.onToggleFavorite(intent.key);
      return;
    case "compare":
      context.onCompare(intent.base);
      return;
  }
}
