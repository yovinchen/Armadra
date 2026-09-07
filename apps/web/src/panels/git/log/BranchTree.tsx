import { useMemo, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Star } from "lucide-react";

import { useT } from "../../../app/preferences-store";
import { cn } from "../../../lib/cn";
import { Input } from "../../../ui/input";
import {
  buildBranchTree,
  flattenTree,
  refKey,
  type BranchTreeNode,
} from "./build-tree";
import { repositoryColor } from "./graph";
import type { GitRefsRepository } from "./types";

/**
 * 左栏分支树（Git 工具窗口设计 §2.2）。
 *
 * 树的形状全部由 `build-tree.ts` 算好，这里只负责画和收事件——**点击 = 单选，
 * ⌘（Windows 上 Ctrl）点击 = 加选**。选中的是「引用」而不是「节点」：同一条
 * 分支在两个仓库里是两件事，所以选中集合里的键是 `refKey(仓库, 引用)`。
 */

export interface BranchTreeProps {
  repositories: readonly GitRefsRepository[];
  /** 仓库路径 → 调色板序号，根节点上那个色点用它。 */
  colors: ReadonlyMap<string, number>;
  filter: string;
  onFilterChange: (value: string) => void;
  /** 选中的引用键；空 = `HEAD`（全部仓库）。 */
  selected: readonly string[];
  onSelect: (node: BranchTreeNode, additive: boolean) => void;
  expanded: readonly string[];
  onToggleExpanded: (id: string) => void;
  favorites: readonly string[];
  onToggleFavorite: (key: string) => void;
  /** 右键菜单由页面提供：它才知道当前仓库的动作与确认门。 */
  renderNodeMenu?: (node: BranchTreeNode, row: ReactNode) => ReactNode;
}

export function BranchTree({
  repositories,
  colors,
  filter,
  onFilterChange,
  selected,
  onSelect,
  expanded,
  onToggleExpanded,
  favorites,
  onToggleFavorite,
  renderNodeMenu,
}: BranchTreeProps) {
  const t = useT();
  const tree = useMemo(
    () => buildBranchTree(repositories, { favorites, filter, colors }),
    [repositories, favorites, filter, colors],
  );
  // 过滤时全部展开：过滤的目的就是「让我看见它」，还要再点开一层是白做。
  const open = useMemo(
    () =>
      filter.trim() === "" ? new Set(expanded) : new Set(allNodeIds(tree)),
    [expanded, filter, tree],
  );
  const rows = useMemo(() => flattenTree(tree, open), [tree, open]);
  const chosen = useMemo(() => new Set(selected), [selected]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border p-1.5">
        <Input
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
          placeholder={t("gitLog.tree.filter")}
          aria-label={t("gitLog.tree.filter")}
          className="h-7 text-xs"
        />
      </div>
      <div
        role="tree"
        aria-label={t("gitLog.tree.title")}
        aria-multiselectable
        className="min-h-0 flex-1 overflow-auto py-1"
      >
        {rows.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {t("gitLog.tree.empty")}
          </p>
        )}
        {rows.map(({ node, depth, expandable, expanded: isOpen }) => {
          const key =
            node.repositoryPath && node.reference
              ? refKey(node.repositoryPath, node.reference)
              : null;
          const isSelected =
            node.kind === "head"
              ? chosen.size === 0
              : key !== null && chosen.has(key);
          const row = (
            <div
              role="treeitem"
              aria-selected={isSelected}
              aria-expanded={expandable ? isOpen : undefined}
              data-node={node.id}
              className={cn(
                "flex min-h-6 w-full min-w-0 items-center gap-1 pr-1 text-xs",
                isSelected && "bg-muted",
              )}
              style={{ paddingLeft: `${depth * 12 + 4}px` }}
            >
              <button
                type="button"
                aria-hidden={!expandable}
                tabIndex={expandable ? 0 : -1}
                aria-label={node.label}
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted",
                  !expandable && "invisible",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleExpanded(node.id);
                }}
              >
                {isOpen ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
              </button>
              {node.kind === "repository" && (
                <span
                  aria-hidden
                  data-slot="git-log-repository-dot"
                  className="size-2 shrink-0 rounded-full"
                  style={{
                    background: repositoryColor(
                      colors.get(node.repositoryPath ?? "") ?? 0,
                    ),
                  }}
                />
              )}
              <button
                type="button"
                className={cn(
                  "min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left hover:bg-muted",
                  node.current && node.kind === "branch" && "font-semibold",
                )}
                title={node.reference ?? node.label}
                onClick={(event) =>
                  onSelect(node, event.metaKey || event.ctrlKey)
                }
              >
                {node.current && node.kind === "branch" ? "✓ " : ""}
                {node.kind === "group"
                  ? node.group === "stashes"
                    ? t("gitLog.tree.stashCount", {
                        count: String(node.count ?? 0),
                      })
                    : t(`gitLog.tree.${node.group}`)
                  : node.label}
              </button>
              {node.kind === "branch" &&
                (node.ahead ? (
                  <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                    ↑{node.ahead}
                  </span>
                ) : null)}
              {node.kind === "branch" &&
                (node.behind ? (
                  <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                    ↓{node.behind}
                  </span>
                ) : null)}
              {key !== null &&
                (node.kind === "branch" || node.kind === "tag") && (
                  <button
                    type="button"
                    aria-pressed={node.favorite ?? false}
                    aria-label={t(
                      node.favorite
                        ? "gitLog.tree.unfavorite"
                        : "gitLog.tree.favorite",
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleFavorite(key);
                    }}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted aria-pressed:text-[var(--brand)]"
                  >
                    <Star
                      className="size-3"
                      fill={node.favorite ? "currentColor" : "none"}
                    />
                  </button>
                )}
            </div>
          );
          return (
            <div key={node.id}>
              {renderNodeMenu ? renderNodeMenu(node, row) : row}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function allNodeIds(nodes: readonly BranchTreeNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...allNodeIds(node.children)]);
}
