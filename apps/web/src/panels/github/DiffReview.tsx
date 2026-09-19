import * as React from "react";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import { useT } from "@/app/preferences-store";
import {
  anchorFor,
  anchorKey,
  commentable,
  commentsByAnchor,
  parsePatch,
  type CommentAnchor,
} from "./diff";
import {
  GithubPullFile,
  GithubReviewComment,
  GithubReviewCommentDraft,
} from "../../api/github";

export interface DiffReviewProps {
  files: readonly GithubPullFile[];
  comments: readonly GithubReviewComment[];
  /** Drafts not yet submitted, keyed by [anchorKey]. */
  drafts: ReadonlyMap<string, GithubReviewCommentDraft>;
  canWrite: boolean;
  onDraft: (key: string, draft: GithubReviewCommentDraft) => void;
  onDiscard: (key: string) => void;
}

/**
 * 文件差异，带行内评论入口（Git/GitHub 设计 §8「评审」）。
 *
 * 每条草稿都记下 path / 行号 / 左右侧——评论的位置来自 hunk 头算出来的行号，
 * 不是数组下标。已提交的行内评论挂在对应行下面；被远端标为 `outdated` 的那些
 * **不挂**，它们锚在另一个 commit 上，画到同号行上就是贴错位置，改为在文件
 * 末尾单独列出并标明过期。
 *
 * 二进制文件和 patch 太大被丢掉的文件没有行内入口，只显示统计——没有行号可
 * 依附时给一个入口，产出的只会是一条位置不明的评论。
 */
export function DiffReview({
  files,
  comments,
  drafts,
  canWrite,
  onDraft,
  onDiscard,
}: DiffReviewProps) {
  const t = useT();
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());
  const anchored = React.useMemo(() => commentsByAnchor(comments), [comments]);
  const outdated = comments.filter((comment) => comment.outdated);

  return (
    <section className="min-w-0 space-y-2" data-slot="github-diff">
      <h4 className="text-[12px] font-medium text-muted-foreground">
        {t("github.pull.diffSummary")}
      </h4>
      {files.map((file) => (
        <FileDiff
          key={file.path}
          file={file}
          expanded={open.has(file.path)}
          onToggle={() =>
            setOpen((current) => {
              const next = new Set(current);
              if (!next.delete(file.path)) next.add(file.path);
              return next;
            })
          }
          anchored={anchored}
          drafts={drafts}
          canWrite={canWrite}
          onDraft={onDraft}
          onDiscard={onDiscard}
        />
      ))}
      {outdated.length > 0 && (
        <div className="min-w-0 space-y-1 rounded-md border border-border px-3 py-2 text-[11px] text-muted-foreground">
          <p>{t("github.review.outdatedNote")}</p>
          {outdated.map((comment) => (
            <p key={String(comment.id)} className="min-w-0 truncate">
              <span className="font-mono">{comment.path}</span> ·{" "}
              {comment.author?.login} · {comment.body}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

function FileDiff({
  file,
  expanded,
  onToggle,
  anchored,
  drafts,
  canWrite,
  onDraft,
  onDiscard,
}: {
  file: GithubPullFile;
  expanded: boolean;
  onToggle: () => void;
  anchored: Map<string, GithubReviewComment[]>;
  drafts: ReadonlyMap<string, GithubReviewCommentDraft>;
  canWrite: boolean;
  onDraft: (key: string, draft: GithubReviewCommentDraft) => void;
  onDiscard: (key: string) => void;
}) {
  const t = useT();
  const lines = React.useMemo(
    () => (expanded ? parsePatch(file.patch) : []),
    [expanded, file.patch],
  );
  const inlineable = commentable(file);

  return (
    <div
      className="min-w-0 rounded-md border border-border"
      data-path={file.path}
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-[12px] hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
        disabled={!inlineable}
        aria-expanded={inlineable ? expanded : undefined}
        onClick={onToggle}
      >
        <span className="min-w-0 flex-1 truncate font-mono select-text">
          {file.path}
        </span>
        {file.binary ? (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {t("github.pull.binary")}
          </Badge>
        ) : (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            +{String(file.additions)} −{String(file.deletions)}
          </span>
        )}
      </button>
      {!inlineable && !file.binary && (
        <p className="px-2 pb-1.5 text-[11px] text-muted-foreground">
          {t("github.review.noPatch")}
        </p>
      )}
      {expanded && (
        <div className="min-w-0 overflow-x-auto border-t border-border">
          <table className="w-full border-collapse font-mono text-[11px]">
            <tbody>
              {lines.map((line, index) => {
                const anchor = anchorFor(file.path, line);
                const key = anchor ? anchorKey(anchor) : null;
                const draft = key ? drafts.get(key) : undefined;
                const existing = key ? (anchored.get(key) ?? []) : [];
                return (
                  <React.Fragment key={`${file.path}:${index}`}>
                    <tr
                      className="group align-top"
                      data-line-kind={line.kind}
                      data-line={anchor?.line}
                      data-side={anchor?.side}
                    >
                      <td className="w-10 shrink-0 px-1 text-right text-muted-foreground tabular-nums select-none">
                        {line.leftLine ?? ""}
                      </td>
                      <td className="w-10 shrink-0 px-1 text-right text-muted-foreground tabular-nums select-none">
                        {line.rightLine ?? ""}
                      </td>
                      <td className="w-6 shrink-0 px-1 text-center select-none">
                        {canWrite && anchor && !draft ? (
                          <button
                            type="button"
                            data-slot="github-inline-comment"
                            aria-label={t("github.review.inlineAdd")}
                            className="rounded-[var(--r-control)] px-1 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-accent"
                            onClick={() =>
                              onDraft(key!, {
                                path: anchor.path,
                                line: BigInt(anchor.line),
                                side: anchor.side,
                                body: "",
                              })
                            }
                          >
                            +
                          </button>
                        ) : null}
                      </td>
                      <td
                        className={`min-w-0 px-1 whitespace-pre select-text ${
                          line.kind === "add"
                            ? "bg-[var(--success)]/10"
                            : line.kind === "remove"
                              ? "bg-[var(--danger)]/10"
                              : line.kind === "meta"
                                ? "text-muted-foreground"
                                : ""
                        }`}
                      >
                        {line.text}
                      </td>
                    </tr>
                    {existing.map((comment) => (
                      <tr key={String(comment.id)}>
                        <td colSpan={4} className="px-2 py-1">
                          <div className="min-w-0 rounded-md border border-border px-2 py-1 font-sans text-[11px]">
                            <span className="text-muted-foreground">
                              {comment.author?.login}
                            </span>
                            <p className="min-w-0 break-words whitespace-pre-wrap select-text">
                              {comment.body}
                            </p>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {draft && key ? (
                      <tr>
                        <td colSpan={4} className="px-2 py-1">
                          <DraftEditor
                            anchor={anchor!}
                            draft={draft}
                            onChange={(body) =>
                              onDraft(key, { ...draft, body })
                            }
                            onDiscard={() => onDiscard(key)}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DraftEditor({
  anchor,
  draft,
  onChange,
  onDiscard,
}: {
  anchor: CommentAnchor;
  draft: GithubReviewCommentDraft;
  onChange: (body: string) => void;
  onDiscard: () => void;
}) {
  const t = useT();
  return (
    <div
      className="min-w-0 space-y-1 rounded-md border border-border px-2 py-1.5 font-sans"
      data-slot="github-inline-draft"
      data-line={anchor.line}
      data-side={anchor.side}
    >
      <p className="text-[11px] text-muted-foreground">
        {t("github.review.inlineAt", {
          side: anchor.side,
          line: String(anchor.line),
        })}
      </p>
      <Textarea
        rows={2}
        value={draft.body}
        aria-label={t("github.review.inlineBody")}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 text-[12px]"
      />
      <Button
        size="sm"
        variant="ghost"
        className="min-h-8"
        onClick={onDiscard}
        type="button"
      >
        {t("github.review.inlineDiscard")}
      </Button>
    </div>
  );
}
