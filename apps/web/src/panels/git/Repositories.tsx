import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GitRepositoryRecord } from "@armadra/shared";
import { FolderGit2, GitBranch, Layers, Package } from "lucide-react";
import { runtimeApi } from "../../api/client";
import { useT } from "../../app/preferences-store";
import { cn } from "../../lib/cn";

/**
 * 多仓库识别与切换（roadmap §4.1）。
 *
 * 一个工作空间目录下可能有根仓库、子目录里的独立仓库、submodule 和链接
 * worktree。Runtime 一次扫描把它们全部报出来，这里只负责挑一个：面板的每个
 * Git 请求都带上被选中的 `repositoryPath`，缺省是工作空间根 `"."`。
 */

/** 「全部仓库」只用于 Changes 的只读聚合视图；提交永远作用于一个明确仓库。 */
export const ALL_REPOSITORIES = "*";

export type RepositorySelection = string;

export function useRepositories(workspaceId: string | null) {
  return useQuery({
    queryKey: ["git-repositories", workspaceId],
    queryFn: ({ signal }) =>
      runtimeApi.gitRepositories(workspaceId!, {}, signal),
    enabled: Boolean(workspaceId),
    retry: false,
  });
}

const ICONS = {
  root: FolderGit2,
  nested: Package,
  submodule: Layers,
  worktree: GitBranch,
} as const;

/**
 * 按父仓库分组后的扁平列表：每个根/独立仓库后面紧跟它的 submodule 与
 * worktree，`depth` 只用于缩进。
 *
 * worktree 与主仓库共用同一个 `repositoryId`（本来就是同一个仓库的不同
 * 检出），所以这里一律用 `repositoryPath` 作为身份，`parentRepositoryId`
 * 指回自己时按顶层处理。
 */
export function groupRepositories(
  repositories: readonly GitRepositoryRecord[],
): { record: GitRepositoryRecord; depth: number }[] {
  const roots = repositories.filter(
    (record) =>
      record.parentRepositoryId === null ||
      !repositories.some(
        (candidate) =>
          candidate.repositoryPath !== record.repositoryPath &&
          candidate.repositoryId === record.parentRepositoryId,
      ),
  );
  const seen = new Set<string>();
  const result: { record: GitRepositoryRecord; depth: number }[] = [];
  const push = (record: GitRepositoryRecord, depth: number) => {
    if (seen.has(record.repositoryPath)) return;
    seen.add(record.repositoryPath);
    result.push({ record, depth });
    for (const child of repositories) {
      if (
        child.repositoryPath !== record.repositoryPath &&
        child.parentRepositoryId === record.repositoryId
      ) {
        push(child, depth + 1);
      }
    }
  };
  for (const root of roots) push(root, 0);
  // 任何没被归到某个父仓库下的记录仍然要出现，宁可平铺也不能丢。
  for (const record of repositories) push(record, 0);
  return result;
}

/** 顶部切换器：一行，够窄屏用。 */
export function RepositorySwitcher({
  repositories,
  value,
  onChange,
  allowAll,
  pending,
}: {
  repositories: readonly GitRepositoryRecord[];
  value: RepositorySelection;
  onChange: (value: RepositorySelection) => void;
  allowAll: boolean;
  pending: boolean;
}) {
  const t = useT();
  const grouped = useMemo(
    () => groupRepositories(repositories),
    [repositories],
  );
  if (repositories.length <= 1 && !pending) return null;
  return (
    <label className="flex min-w-0 items-center gap-2 text-xs">
      <span className="shrink-0 text-muted-foreground">
        {t("gitRepo.repository")}
      </span>
      <select
        aria-label={t("gitRepo.repositorySwitcher")}
        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {allowAll && (
          <option value={ALL_REPOSITORIES}>
            {t("gitRepo.allRepositories")}
          </option>
        )}
        {grouped.map(({ record, depth }) => (
          <option key={record.repositoryPath} value={record.repositoryPath}>
            {`${"  ".repeat(depth)}${record.name}${
              record.headBranch ? ` · ${record.headBranch}` : ""
            }`}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * 左侧分组列表：图标、名称、当前分支、脏文件数。
 *
 * `dirtyCount === null` 是「没有执行权限所以没数」，和 0 是两回事，必须
 * 分开显示——把未知说成干净会让人放心地丢掉改动。
 */
export function RepositoryList({
  repositories,
  value,
  onChange,
  allowAll,
}: {
  repositories: readonly GitRepositoryRecord[];
  value: RepositorySelection;
  onChange: (value: RepositorySelection) => void;
  allowAll: boolean;
}) {
  const t = useT();
  const grouped = useMemo(
    () => groupRepositories(repositories),
    [repositories],
  );
  return (
    <nav
      aria-label={t("gitRepo.repositoryList")}
      className="min-w-0 space-y-0.5"
    >
      {allowAll && (
        <button
          type="button"
          aria-pressed={value === ALL_REPOSITORIES}
          onClick={() => onChange(ALL_REPOSITORIES)}
          className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted aria-pressed:bg-muted"
        >
          <Layers aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {t("gitRepo.allRepositories")}
          </span>
        </button>
      )}
      {grouped.map(({ record, depth }) => {
        const Icon = ICONS[record.kind];
        return (
          <button
            key={record.repositoryPath}
            type="button"
            aria-pressed={value === record.repositoryPath}
            onClick={() => onChange(record.repositoryPath)}
            title={record.repositoryPath}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            className="flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 pr-2 text-left text-xs hover:bg-muted aria-pressed:bg-muted"
          >
            <Icon aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-medium">
              {record.name}
            </span>
            <span className="shrink-0 truncate font-mono text-[11px] text-muted-foreground">
              {record.headBranch ?? t("gitRepo.detached")}
            </span>
            <span
              className={cn(
                "shrink-0 rounded px-1 text-[11px] tabular-nums",
                record.dirtyCount === null
                  ? "text-muted-foreground"
                  : record.dirtyCount > 0
                    ? "bg-muted font-medium"
                    : "text-muted-foreground",
              )}
              title={
                record.dirtyCount === null
                  ? t("gitRepo.dirtyUnknown")
                  : t("gitRepo.dirtyCount")
              }
            >
              {record.dirtyCount === null ? "—" : record.dirtyCount}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
