import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, FileDiff, Folder } from "lucide-react";
import type { GitLogCommit } from "@armadra/shared";

import { useT, usePreferencesStore } from "../../../app/preferences-store";
import { gitGateway, type GitTarget } from "../../../git/gateway";
import { writeClipboard } from "../../../terminal/TerminalSurface";
import { cn } from "../../../lib/cn";
import { Button } from "../../../ui/button";
import { ReadError } from "../forms";
import { refBadges } from "../CommitGraph";
import { buildFileRows } from "./file-tree";

/**
 * 详情栏（Git 工具窗口设计 §2.2「详情」）。
 *
 * hash、作者 / 提交者、ref 徽标、完整信息，下面是变更文件树；点一个文件在
 * **同一栏里**展开差异，而不是弹一个新面板——三栏已经把宽度分完了，第四块
 * 面板只会把每一块都挤到没法读。
 *
 * 合并提交多一个「与哪个父比」的切换。合并提交对第一父的差异是「这次合并带
 * 进来了什么」，对第二父的差异是「主线上多了什么」，两句话都要能问得出来，
 * 所以这里不替用户选一个。
 */

export interface CommitDetailsProps {
  workspaceId: string;
  /** 这个提交所在的检出；读写走同一条归属判定。 */
  target: GitTarget;
  commit: GitLogCommit;
  /**
   * 与哪个基线比。`null` = 服务端的缺省（第一父）；合并提交的父切换与右键
   * 菜单的「与本地比较 / 与分支比较」写的是同一个值，所以两处不会打架。
   */
  base: string | null;
  onBaseChange: (base: string | null) => void;
  /** 手机上第四级（文件差异）由外面驱动，桌面上留空即可。 */
  onOpenFile?: (path: string) => void;
}

export function CommitDetails({
  workspaceId,
  target,
  commit,
  base,
  onBaseChange,
  onOpenFile,
}: CommitDetailsProps) {
  const t = useT();
  const flat = usePreferencesStore((state) => state.git.flatFiles);
  const setPreference = usePreferencesStore((state) => state.setGitPreference);
  const [copied, setCopied] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const merge = commit.parents.length > 1;
  const repositoryKey = `${target.repositoryPath}:${commit.repositoryPath}`;

  const detail = useQuery({
    queryKey: ["git-log-commit", workspaceId, repositoryKey, commit.oid, base],
    queryFn: ({ signal }) =>
      gitGateway.commitDetail(target, commit.oid, base, signal),
    retry: false,
  });
  const patch = useQuery({
    queryKey: [
      "git-log-commit-file",
      workspaceId,
      repositoryKey,
      commit.oid,
      base,
      file,
    ],
    queryFn: ({ signal }) =>
      gitGateway.commitFile(target, commit.oid, base, file!, signal),
    enabled: file !== null,
    retry: false,
  });

  const badges = useMemo(() => refBadges(commit.refs), [commit.refs]);
  const rows = useMemo(
    () => buildFileRows(detail.data?.files ?? [], flat),
    [detail.data, flat],
  );

  return (
    <div
      data-slot="git-log-details"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto p-2 text-xs"
    >
      <div className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 flex-1 truncate font-mono">{commit.oid}</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5"
          aria-label={t("gitLog.details.copyHash")}
          onClick={() => {
            writeClipboard(commit.oid);
            setCopied(true);
          }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </Button>
      </div>
      {badges.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {badges.map((badge) => (
            <span
              key={`${badge.kind}:${badge.label}`}
              className={cn(
                "rounded px-1 text-[10px] leading-4",
                badge.kind === "tag"
                  ? "bg-[color-mix(in_srgb,var(--brand)_16%,transparent)] text-[var(--brand)]"
                  : badge.kind === "head"
                    ? "bg-foreground text-background"
                    : "border border-border text-muted-foreground",
              )}
            >
              {badge.label}
            </span>
          ))}
        </div>
      )}
      <dl className="mt-2 space-y-1">
        <div>
          <dt className="text-muted-foreground">{t("gitRepo.author")}</dt>
          <dd className="break-words">
            {commit.authorName} &lt;{commit.authorEmail}&gt; ·{" "}
            {commit.authorTime}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("gitLog.details.committer")}
          </dt>
          <dd className="break-words">{commit.committerTime}</dd>
        </div>
      </dl>
      <p className="mt-2 whitespace-pre-wrap break-words">{commit.subject}</p>

      {merge && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">
            {t("gitLog.details.parent")}
          </span>
          {commit.parents.map((oid, index) => (
            <Button
              key={oid}
              size="sm"
              variant="ghost"
              aria-pressed={base === oid || (base === null && index === 0)}
              className="h-6 px-1.5 font-mono text-[11px] aria-pressed:bg-muted"
              onClick={() => {
                onBaseChange(index === 0 ? null : oid);
                setFile(null);
              }}
            >
              {t("gitLog.details.parentIndex", { index: String(index + 1) })}
            </Button>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-1 border-t border-border pt-2">
        <h3 className="min-w-0 flex-1 truncate font-semibold">
          {t("gitLog.details.files")}
        </h3>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5"
          aria-pressed={flat}
          aria-label={t(flat ? "gitLog.details.tree" : "gitLog.details.flat")}
          onClick={() => setPreference("flatFiles", !flat)}
        >
          <Folder className="size-3" />
        </Button>
      </div>
      {detail.isPending && <p role="status">{t("gitLog.table.loading")}</p>}
      {detail.error && (
        <ReadError error={detail.error} retry={() => void detail.refetch()} />
      )}
      {detail.data?.truncated && (
        <p className="text-muted-foreground">{t("gitRepo.filesTruncated")}</p>
      )}
      {detail.data && detail.data.files.length === 0 && (
        <p className="text-muted-foreground">{t("gitRepo.noChangedFiles")}</p>
      )}
      <ul className="min-w-0">
        {rows.map((row) =>
          row.kind === "directory" ? (
            <li
              key={`dir:${row.path}`}
              className="flex min-w-0 items-center gap-1 py-0.5 text-muted-foreground"
              style={{ paddingLeft: `${row.depth * 12}px` }}
            >
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              <span className="shrink-0 tabular-nums">{row.count}</span>
            </li>
          ) : (
            <li key={`file:${row.path}`} className="min-w-0">
              <button
                type="button"
                aria-pressed={file === row.path}
                onClick={() => {
                  setFile(row.path);
                  onOpenFile?.(row.path);
                }}
                style={{ paddingLeft: `${row.depth * 12}px` }}
                className="flex w-full min-w-0 items-center gap-2 rounded py-0.5 pr-1 text-left hover:bg-muted aria-pressed:bg-muted"
              >
                <span className="w-3 shrink-0 font-mono">
                  {row.file?.status.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1 truncate" title={row.path}>
                  {row.label}
                  {row.renamedFrom && (
                    <span className="text-muted-foreground">
                      {" ← "}
                      {row.renamedFrom}
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {row.file?.additions === null || row.file?.deletions === null
                    ? t("gitRepo.binaryFile")
                    : `+${row.file?.additions} −${row.file?.deletions}`}
                </span>
              </button>
            </li>
          ),
        )}
      </ul>

      {file !== null && (
        <section className="mt-2 min-w-0 border-t border-border pt-2">
          <div className="flex items-center gap-1">
            <FileDiff aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-mono">{file}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5"
              onClick={() => setFile(null)}
            >
              {t("gitLog.details.closeDiff")}
            </Button>
          </div>
          {patch.isPending && <p role="status">{t("gitLog.table.loading")}</p>}
          {patch.error && (
            <ReadError error={patch.error} retry={() => void patch.refetch()} />
          )}
          {patch.data && (
            <>
              {patch.data.truncated && (
                <p className="text-muted-foreground">
                  {t("gitRepo.patchTruncated")}
                </p>
              )}
              <pre
                aria-label={t("gitRepo.filePatch")}
                className="max-h-72 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-4"
              >
                {patch.data.patch}
              </pre>
            </>
          )}
        </section>
      )}
    </div>
  );
}
