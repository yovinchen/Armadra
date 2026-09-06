// 变更列表的一行与一段。行为全部由调用方通过 `actions` 传进来，所以聚合视图
// 里来自不同仓库的行可以用同一段渲染，各自打到自己的仓库上。
import type { DiffScope, GitFileStatus } from "@armadra/shared";
import { useT } from "../../app/preferences-store";
import { Badge } from "../../ui/badge";
import { IconButton } from "../../ui/icon-button";
import { FileDiff, ListFilter, Minus, Plus, Undo2 } from "lucide-react";
import { FileTypeIcon } from "../../nodes/files/file-icons";

type DiffFileStatus = GitFileStatus["status"];

const STATUS_COLOR: Record<DiffFileStatus, string> = {
  M: "var(--warn)",
  A: "var(--success)",
  D: "var(--danger)",
  R: "var(--brand)",
  "?": "var(--muted-foreground)",
};

/** 一行变更：聚合视图里还记得自己来自哪个仓库。 */
export type ChangeEntry = GitFileStatus & {
  repositoryPath?: string;
  repositoryName?: string;
};

/** 一行上能做的事。谁来做由抽屉决定，这里只负责按下去。 */
export type ChangeActions = {
  /** 没有 `repositoryPath` 的行属于这个仓库。 */
  repositoryPath: string;
  onHunk: (path: string, scope: DiffScope) => void;
  onDiff: (path: string, scope: DiffScope, repository: string) => void;
  onStage: (input: { path: string; repository: string }) => void;
  onUnstage: (input: { path: string; repository: string }) => void;
  onRestore: (input: {
    path: string;
    untracked: boolean;
    repository: string;
  }) => void;
};

function ChangeRow({
  file,
  scope,
  actions,
}: {
  file: ChangeEntry;
  scope: DiffScope;
  actions: ChangeActions;
}) {
  const t = useT();
  const repository = file.repositoryPath ?? actions.repositoryPath;
  return (
    <div className="group flex h-8 items-center gap-2 rounded-md px-2 hover:bg-muted">
      {/*
        图标位放文件类型，不放 Git 状态字母：未跟踪文件的状态字母是 `?`，
        坐在行首的图标位上读起来就是「图标没加载出来」。状态挪到文件名后面，
        和 `explorer.status.*` 的说明一起。
      */}
      <FileTypeIcon
        path={file.path}
        className="size-4 shrink-0 text-muted-foreground"
      />
      {/* 聚合视图里同名文件可能来自不同仓库，行上必须写清是哪一个。 */}
      {file.repositoryName && (
        <Badge
          variant="ghost"
          className="h-4 shrink-0 px-1 text-[length:var(--text-caption)] text-muted-foreground"
          title={repository}
        >
          {file.repositoryName}
        </Badge>
      )}
      <span
        className="flex-1 truncate text-[13px]"
        title={`${repository === "." ? "" : `${repository}/`}${file.path}`}
      >
        {file.path}
      </span>
      <Badge
        variant="ghost"
        className="h-4 w-4 shrink-0 justify-center p-0 font-mono text-[length:var(--text-caption)] font-bold"
        style={{ color: STATUS_COLOR[file.status] }}
        title={t(`explorer.status.${file.status}`)}
      >
        {file.status}
      </Badge>
      <div className="flex items-center gap-0.5">
        <IconButton
          label={t("gitHunk.title")}
          onClick={() => actions.onHunk(file.path, scope)}
        >
          <ListFilter />
        </IconButton>
        <IconButton
          label={t("scm.diff")}
          onClick={() => actions.onDiff(file.path, scope, repository)}
        >
          <FileDiff />
        </IconButton>
        {scope === "staged" ? (
          <IconButton
            label={t("scm.unstage")}
            onClick={() => actions.onUnstage({ path: file.path, repository })}
          >
            <Minus />
          </IconButton>
        ) : (
          <IconButton
            label={t("scm.stage")}
            onClick={() => actions.onStage({ path: file.path, repository })}
          >
            <Plus />
          </IconButton>
        )}
        <IconButton
          label={t("scm.restore")}
          onClick={() =>
            actions.onRestore({
              path: file.path,
              untracked: file.status === "?",
              repository,
            })
          }
        >
          <Undo2 />
        </IconButton>
      </div>
    </div>
  );
}

export function ChangeSection({
  label,
  rows,
  scope,
  actions,
}: {
  label: string;
  rows: ChangeEntry[];
  scope: DiffScope;
  actions: ChangeActions;
}) {
  return rows.length === 0 ? null : (
    <section className="px-2 py-1">
      <h3 className="px-2 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
        {label}
        <span className="ml-1 tabular-nums">{rows.length}</span>
      </h3>
      {rows.map((file) => (
        <ChangeRow
          key={`${file.repositoryPath ?? actions.repositoryPath}:${scope}:${file.path}`}
          file={file}
          scope={scope}
          actions={actions}
        />
      ))}
    </section>
  );
}
