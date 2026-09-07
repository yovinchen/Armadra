/**
 * 提交页的变更树（Git 工具窗口设计 §2.3）。
 *
 * 一个复选框就是一次 `git add` / `git restore --staged`：界面上不再有「暂存区」
 * 这个额外概念，勾上的行就是这次提交的内容。所以每个复选框都必须和索引说的
 * 一致——乐观更新之后失败要回滚，否则界面会声称一个没发生的暂存。
 */
import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  GitMerge,
  FolderGit2,
} from "lucide-react";
import { useT } from "../../../app/preferences-store";
import { cn } from "../../../lib/cn";
import { Badge } from "../../../ui/badge";
import { FileTypeIcon } from "../../../nodes/files/file-icons";
import {
  pendingKey,
  type ChangeDirectoryNode,
  type ChangeFileNode,
  type ChangeNode,
  type ChangeStatus,
  type ChangeToggle,
  type RepositoryChangeGroup,
} from "./build-change-tree";

const STATUS_COLOR: Record<ChangeStatus, string> = {
  M: "var(--warn)",
  A: "var(--success)",
  D: "var(--danger)",
  R: "var(--brand)",
  "?": "var(--muted-foreground)",
};

export interface ChangeTreeProps {
  groups: readonly RepositoryChangeGroup[];
  /** 单仓库时不显示仓库这一层（设计 §2.3）。 */
  showRepositories: boolean;
  selectedId: string | null;
  onSelect: (node: ChangeFileNode) => void;
  onToggle: (toggle: ChangeToggle) => void;
  /** 冲突文件双击：进三方合并。 */
  onResolve: (node: ChangeFileNode) => void;
  /** 还在等服务端回话的路径（`pendingKey()`）；这些复选框先不给按第二次。 */
  pending: ReadonlySet<string>;
  disabled?: boolean;
}

function Checkbox({
  checked,
  partial,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  partial?: boolean;
  label: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      className="size-3.5 shrink-0 accent-[var(--brand)]"
      checked={checked}
      disabled={disabled}
      // indeterminate 只有属性没有 attribute，只能落到节点上。
      ref={(node) => {
        if (node) node.indeterminate = Boolean(partial) && !checked;
      }}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function StatusBadge({ node }: { node: ChangeFileNode }) {
  const t = useT();
  const conflicted = node.group === "conflicts";
  return (
    <Badge
      variant="ghost"
      className="h-4 w-4 shrink-0 justify-center p-0 font-mono text-[length:var(--text-caption)] font-bold"
      style={{
        color: conflicted ? "var(--danger)" : STATUS_COLOR[node.status],
      }}
      title={t(
        conflicted
          ? "gitCommit.group.conflicts"
          : `explorer.status.${node.status}`,
      )}
    >
      {conflicted ? "U" : node.status}
    </Badge>
  );
}

function FileRow({
  node,
  selected,
  pending,
  disabled,
  onSelect,
  onToggle,
  onResolve,
}: {
  node: ChangeFileNode;
  selected: boolean;
  pending: boolean;
  disabled: boolean;
  onSelect: (node: ChangeFileNode) => void;
  onToggle: (toggle: ChangeToggle) => void;
  onResolve: (node: ChangeFileNode) => void;
}) {
  const t = useT();
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      tabIndex={0}
      title={node.path}
      style={{ paddingLeft: `${node.depth * 14 + 8}px` }}
      className={cn(
        "group flex h-7 min-w-0 cursor-default items-center gap-2 rounded-md pr-2 text-[13px] hover:bg-muted",
        selected && "bg-muted",
      )}
      onClick={() => onSelect(node)}
      onDoubleClick={() => {
        if (node.group === "conflicts") onResolve(node);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(node);
        }
      }}
    >
      <Checkbox
        checked={node.staged}
        disabled={disabled || pending}
        label={t(node.staged ? "scm.unstage" : "scm.stage")}
        onChange={(next) =>
          onToggle({
            repositoryPath: node.repositoryPath,
            paths: [node.path],
            stage: next,
            group: node.group,
          })
        }
      />
      <FileTypeIcon
        path={node.path}
        className="size-4 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate">{node.label}</span>
      {node.originPath && (
        <span
          className="min-w-0 shrink truncate text-[11px] text-muted-foreground"
          title={t("gitCommit.renamedFrom", { path: node.originPath })}
        >
          ← {node.originPath}
        </span>
      )}
      {node.group === "conflicts" && (
        <GitMerge
          aria-hidden
          className="size-3.5 shrink-0 text-[var(--danger)]"
        />
      )}
      <StatusBadge node={node} />
    </div>
  );
}

function DirectoryRow({
  node,
  collapsed,
  pending,
  disabled,
  onCollapse,
  onToggle,
}: {
  node: ChangeDirectoryNode;
  collapsed: boolean;
  pending: boolean;
  disabled: boolean;
  onCollapse: (id: string) => void;
  onToggle: (toggle: ChangeToggle) => void;
}) {
  const t = useT();
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div
      role="treeitem"
      aria-expanded={!collapsed}
      tabIndex={0}
      title={node.path}
      style={{ paddingLeft: `${node.depth * 14 + 8}px` }}
      className="flex h-7 min-w-0 cursor-default items-center gap-2 rounded-md pr-2 text-[13px] hover:bg-muted"
      onClick={() => onCollapse(node.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onCollapse(node.id);
        }
      }}
    >
      <Checkbox
        checked={node.staged}
        partial={node.partial}
        disabled={disabled || pending}
        label={t(node.staged ? "gitCommit.unstageAll" : "gitCommit.stageAll", {
          path: node.path,
        })}
        onChange={(next) =>
          onToggle({
            repositoryPath: node.repositoryPath,
            paths: node.files,
            stage: next,
            group: node.group,
          })
        }
      />
      <Chevron
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{node.label}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {node.files.length}
      </span>
    </div>
  );
}

function Nodes({
  nodes,
  collapsed,
  onCollapse,
  ...rest
}: {
  nodes: readonly ChangeNode[];
  collapsed: ReadonlySet<string>;
  onCollapse: (id: string) => void;
  selectedId: string | null;
  pending: ReadonlySet<string>;
  disabled: boolean;
  onSelect: (node: ChangeFileNode) => void;
  onToggle: (toggle: ChangeToggle) => void;
  onResolve: (node: ChangeFileNode) => void;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === "file" ? (
          <FileRow
            key={node.id}
            node={node}
            selected={rest.selectedId === node.id}
            pending={rest.pending.has(
              pendingKey(node.repositoryPath, node.path),
            )}
            disabled={rest.disabled}
            onSelect={rest.onSelect}
            onToggle={rest.onToggle}
            onResolve={rest.onResolve}
          />
        ) : (
          <div key={node.id} role="group">
            <DirectoryRow
              node={node}
              collapsed={collapsed.has(node.id)}
              pending={node.files.some((path) =>
                rest.pending.has(pendingKey(node.repositoryPath, path)),
              )}
              disabled={rest.disabled}
              onCollapse={onCollapse}
              onToggle={rest.onToggle}
            />
            {!collapsed.has(node.id) && (
              <Nodes
                nodes={node.children}
                collapsed={collapsed}
                onCollapse={onCollapse}
                {...rest}
              />
            )}
          </div>
        ),
      )}
    </>
  );
}

export function ChangeTree({
  groups,
  showRepositories,
  selectedId,
  onSelect,
  onToggle,
  onResolve,
  pending,
  disabled = false,
}: ChangeTreeProps) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const collapse = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const total = groups.reduce((count, group) => count + group.count, 0);
  if (total === 0)
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground">
        {t("gitCommit.clean")}
      </p>
    );
  return (
    <div
      role="tree"
      aria-label={t("gitCommit.changes")}
      className="min-w-0 pb-2"
    >
      {groups.map((repository) =>
        repository.count === 0 && showRepositories ? null : (
          <section key={repository.repositoryPath} className="min-w-0">
            {showRepositories && (
              <h3
                title={repository.repositoryPath}
                className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground"
              >
                <FolderGit2 aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {repository.name}
                </span>
                <span className="tabular-nums">{repository.count}</span>
              </h3>
            )}
            {repository.sections.map((section) =>
              section.count === 0 ? null : (
                <div key={section.group} className="min-w-0">
                  <h4
                    className={cn(
                      "px-2 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground",
                      showRepositories && "pl-4",
                      section.group === "conflicts" && "text-[var(--danger)]",
                    )}
                  >
                    {t(`gitCommit.group.${section.group}`)}
                    <span className="ml-1 tabular-nums">{section.count}</span>
                  </h4>
                  <div className={cn(showRepositories && "pl-2")}>
                    <Nodes
                      nodes={section.nodes}
                      collapsed={collapsed}
                      onCollapse={collapse}
                      selectedId={selectedId}
                      pending={pending}
                      disabled={disabled}
                      onSelect={onSelect}
                      onToggle={onToggle}
                      onResolve={onResolve}
                    />
                  </div>
                </div>
              ),
            )}
          </section>
        ),
      )}
    </div>
  );
}
