import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  GithubMergeMethod,
  GithubMergeableState,
  GithubReferenceKind,
  GithubReviewState,
  type GithubRepositoryRef,
  type GithubReviewCommentDraft,
  type HostGithubClient,
  type MergeGithubPullResponse,
} from "@armadra/host-client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import { useT } from "@/app/preferences-store";
import { Field, selectClass } from "../git/forms";
import { CheckoutWorktree } from "./CheckoutWorktree";
import { ChecksSection } from "./ChecksSection";
import { DiffReview } from "./DiffReview";
import { MergeCleanup } from "./MergeCleanup";
import {
  checkConclusionKey,
  failureKey,
  instant,
  mergeMethodKey,
  mergeReasonKey,
  pollInterval,
  pullStateKey,
  reviewStateKey,
  shortSha,
} from "./model";
import { ReferenceSection } from "./ReferenceSection";
import { githubKeys } from "./queries";

export interface PullDetailProps {
  client: HostGithubClient;
  workspaceId: string;
  repository: GithubRepositoryRef;
  number: bigint;
  locale: string;
  canWrite: boolean;
  open: boolean;
  onBack: () => void;
}

function mergeableKey(state: GithubMergeableState): string {
  switch (state) {
    case GithubMergeableState.UNKNOWN:
      return "github.mergeable.unknown";
    case GithubMergeableState.MERGEABLE:
      return "github.mergeable.mergeable";
    case GithubMergeableState.CONFLICTING:
      return "github.mergeable.conflicting";
    case GithubMergeableState.BLOCKED:
      return "github.mergeable.blocked";
    default:
      return "github.mergeable.unspecified";
  }
}

/**
 * One pull request: diff summary, reviews, checks and merge.
 *
 * The merge button names the exact head it will merge and sends that SHA plus
 * the check rollup the reader saw, so the Host can refuse when the remote moved
 * underneath. A refusal is reported as the Host's own reason code — never as a
 * success, and never softened into a retry.
 */
export function PullDetail({
  client,
  workspaceId,
  repository,
  number,
  locale,
  canWrite,
  open,
  onBack,
}: PullDetailProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [reviewBody, setReviewBody] = React.useState("");
  /**
   * Inline comment drafts, keyed by their anchor. They live here rather than
   * in the diff view because they are part of the review being composed: one
   * submission carries the body and every draft at once, which is what makes
   * them one review on the remote instead of a scatter of loose comments.
   */
  const [drafts, setDrafts] = React.useState<
    ReadonlyMap<string, GithubReviewCommentDraft>
  >(new Map());
  const [method, setMethod] = React.useState<GithubMergeMethod | null>(null);
  const [confirm, setConfirm] = React.useState(false);
  const [outcome, setOutcome] = React.useState<MergeGithubPullResponse | null>(
    null,
  );

  const detail = useQuery({
    queryKey: githubKeys.pull(workspaceId, repository, number),
    queryFn: () => client.getPull({ repository, number }),
    enabled: open,
    retry: false,
    refetchInterval: (query) =>
      open ? pollInterval(query.state.data?.pollIntervalMs) : false,
  });

  const pull = detail.data?.pull;
  const checks = detail.data?.checks;
  const methods = pull?.allowedMergeMethods ?? [];
  const chosen = method ?? methods[0] ?? null;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: githubKeys.all });
  const fail = (error: unknown) => toast.error(t(failureKey(error)));

  const review = useMutation({
    mutationFn: (state: GithubReviewState) =>
      client.submitReview({
        repository,
        number,
        // The head that was on screen, so the review lands on what was read
        // and every inline comment is anchored to that same commit.
        commitSha: pull!.headSha,
        state,
        body: reviewBody,
        comments: [...drafts.values()].filter((draft) => draft.body.trim()),
      }),
    onSuccess: () => {
      setReviewBody("");
      setDrafts(new Map());
      toast.success(t("github.review.submitted"));
      invalidate();
    },
    onError: fail,
  });

  const merge = useMutation({
    mutationFn: () =>
      client.mergePull({
        repository,
        number,
        expectedHeadSha: pull!.headSha,
        method: chosen!,
        expectedCheckRollup: checks?.rollup,
      }),
    onSuccess: (result) => {
      setOutcome(result);
      invalidate();
    },
    onError: fail,
  });

  const busy = review.isPending || merge.isPending;

  return (
    <div className="min-w-0 space-y-3 p-3">
      <Button size="sm" variant="ghost" className="min-h-10" onClick={onBack}>
        {t("github.back")}
      </Button>

      {detail.isError && (
        <p role="status" className="text-[12px] text-destructive">
          {t(failureKey(detail.error))}
        </p>
      )}
      {!pull ? (
        detail.isPending ? (
          <p role="status" className="text-[12px] text-muted-foreground">
            {t("github.loading")}
          </p>
        ) : null
      ) : (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="shrink-0 tabular-nums text-muted-foreground">
              #{String(pull.number)}
            </span>
            <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium">
              {pull.title}
            </h3>
            <Badge variant="secondary">{t(pullStateKey(pull))}</Badge>
            {pull.draft && (
              <Badge variant="outline">{t("github.pull.draft")}</Badge>
            )}
            {pull.fromFork && (
              <Badge variant="outline">{t("github.pull.fork")}</Badge>
            )}
            <Badge variant="outline">{t(mergeableKey(pull.mergeable))}</Badge>
          </div>

          <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            <dt className="text-muted-foreground">{t("github.pull.base")}</dt>
            <dd className="min-w-0 truncate">{pull.baseRef}</dd>
            <dt className="text-muted-foreground">{t("github.pull.head")}</dt>
            <dd className="min-w-0 truncate">
              {pull.headRef}
              {pull.headRepoFullName ? ` · ${pull.headRepoFullName}` : ""}
            </dd>
            <dt className="text-muted-foreground">
              {t("github.pull.headSha")}
            </dt>
            <dd
              data-slot="github-head-sha"
              className="min-w-0 break-all font-mono select-text"
            >
              {pull.headSha}
            </dd>
            <dt className="text-muted-foreground">
              {t("github.pull.changedFiles")}
            </dt>
            <dd className="tabular-nums">{String(pull.changedFiles)}</dd>
            <dt className="text-muted-foreground">
              {t("github.pull.commits")}
            </dt>
            <dd className="tabular-nums">{String(pull.commits)}</dd>
            <dt className="text-muted-foreground">
              {t("github.issue.updatedAt")}
            </dt>
            <dd className="min-w-0 truncate">
              {instant(pull.updatedAtUnixMs, locale) ??
                t("github.settings.unknown")}
            </dd>
          </dl>

          <p className="text-[11px] text-muted-foreground">
            {t("github.externalNote")}
          </p>

          <p className="text-[12px] tabular-nums">
            {t("github.pull.additions")} {String(pull.additions)} ·{" "}
            {t("github.pull.deletions")} {String(pull.deletions)}
          </p>
          <DiffReview
            files={detail.data!.files}
            comments={detail.data!.reviewComments}
            drafts={drafts}
            canWrite={canWrite}
            onDraft={(key, draft) =>
              setDrafts((current) => new Map(current).set(key, draft))
            }
            onDiscard={(key) =>
              setDrafts((current) => {
                const next = new Map(current);
                next.delete(key);
                return next;
              })
            }
          />

          <ChecksSection
            client={client}
            repository={repository}
            number={number}
            headSha={pull.headSha}
            checks={checks}
            canWrite={canWrite}
            busy={busy}
          />

          <ReferenceSection
            client={client}
            workspaceId={workspaceId}
            repository={repository}
            kind={GithubReferenceKind.PULL_REQUEST}
            number={number}
            title={pull.title}
            references={detail.data!.references}
            canWrite={canWrite}
          />

          <section className="min-w-0 space-y-1">
            <h4 className="text-[12px] font-medium text-muted-foreground">
              {t("github.pull.reviews")}
            </h4>
            {detail.data!.reviews.map((entry) => (
              <article
                key={String(entry.id)}
                className="min-w-0 space-y-1 rounded-md border border-border px-3 py-2 text-[12px]"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-muted-foreground">
                    {entry.author?.login}
                  </span>
                  <Badge variant="outline">
                    {t(reviewStateKey(entry.state))}
                  </Badge>
                </div>
                {entry.body && (
                  <p className="min-w-0 break-words whitespace-pre-wrap select-text">
                    {entry.body}
                  </p>
                )}
              </article>
            ))}
          </section>

          {canWrite && (
            <section className="min-w-0 space-y-2 border-t border-border pt-3">
              <h4 className="text-[12px] font-medium text-muted-foreground">
                {t("github.review.compose")}
              </h4>
              <p className="text-[11px] text-muted-foreground">
                {t("github.review.commit")} · {shortSha(pull.headSha)}
              </p>
              {/*
                行内草稿和这份评审一起提交：它们是同一次评审的一部分，分开发
                会在远端变成一堆孤立评论。
              */}
              {drafts.size > 0 && (
                <p
                  className="text-[11px] text-muted-foreground"
                  data-slot="github-inline-count"
                >
                  {t("github.review.inlineCount", {
                    count: String(drafts.size),
                  })}
                </p>
              )}
              <Field label={t("github.review.body")}>
                <Textarea
                  value={reviewBody}
                  rows={3}
                  onChange={(event) => setReviewBody(event.target.value)}
                  className="min-w-0"
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  className="min-h-10"
                  disabled={busy}
                  onClick={() => review.mutate(GithubReviewState.APPROVED)}
                >
                  {t("github.review.approve")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-10"
                  disabled={busy || !reviewBody.trim()}
                  title={
                    reviewBody.trim() ? undefined : t("github.review.needsBody")
                  }
                  onClick={() =>
                    review.mutate(GithubReviewState.CHANGES_REQUESTED)
                  }
                >
                  {t("github.review.requestChanges")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="min-h-10"
                  disabled={busy}
                  onClick={() => review.mutate(GithubReviewState.COMMENTED)}
                >
                  {t("github.review.comment")}
                </Button>
              </div>
            </section>
          )}

          {canWrite && (
            <section className="min-w-0 space-y-2 border-t border-border pt-3">
              {methods.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">
                  {t("github.merge.noMethod")}
                </p>
              ) : (
                <>
                  <Field label={t("github.merge.method")}>
                    <select
                      className={selectClass}
                      value={String(chosen ?? "")}
                      onChange={(event) =>
                        setMethod(
                          Number(event.target.value) as GithubMergeMethod,
                        )
                      }
                    >
                      {methods.map((value) => (
                        <option key={value} value={String(value)}>
                          {t(mergeMethodKey(value))}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Button
                    size="sm"
                    className="min-h-10"
                    disabled={busy || !pull.headSha}
                    onClick={() => setConfirm(true)}
                  >
                    {t("github.merge")} · {shortSha(pull.headSha)}
                  </Button>
                </>
              )}
              {outcome && (
                <p
                  role="status"
                  className={
                    outcome.merged
                      ? "text-[12px] text-muted-foreground"
                      : "text-[12px] text-destructive"
                  }
                >
                  {outcome.merged
                    ? `${t("github.merge.merged")} · ${shortSha(outcome.mergeSha)}`
                    : `${t("github.merge.notMerged")} · ${outcome.reasonCode}${
                        mergeReasonKey(outcome.reasonCode)
                          ? ` · ${t(mergeReasonKey(outcome.reasonCode)!)}`
                          : ""
                      }`}
                </p>
              )}
            </section>
          )}

          {workspaceId && (
            <CheckoutWorktree
              workspaceId={workspaceId}
              pull={pull}
              busy={busy}
            />
          )}

          {workspaceId && (
            <MergeCleanup
              client={client}
              workspaceId={workspaceId}
              repository={repository}
              pull={pull}
              canWrite={canWrite}
              busy={busy}
            />
          )}

          <AlertDialog
            open={confirm}
            onOpenChange={(next) => {
              if (!next) setConfirm(false);
            }}
          >
            <AlertDialogContent className="z-[var(--z-dialog)]">
              <AlertDialogHeader>
                <AlertDialogTitle>{t("github.merge.confirm")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("github.merge.note")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                <dt className="text-muted-foreground">
                  {t("github.repository")}
                </dt>
                <dd className="min-w-0 truncate">
                  {repository.owner}/{repository.name}
                </dd>
                <dt className="text-muted-foreground">
                  {t("github.pull.base")}
                </dt>
                <dd className="min-w-0 truncate">{pull.baseRef}</dd>
                <dt className="text-muted-foreground">
                  {t("github.pull.headSha")}
                </dt>
                <dd className="min-w-0 break-all font-mono select-text">
                  {pull.headSha}
                </dd>
                <dt className="text-muted-foreground">
                  {t("github.merge.method")}
                </dt>
                <dd>{chosen === null ? "" : t(mergeMethodKey(chosen))}</dd>
                <dt className="text-muted-foreground">
                  {t("github.pull.checkRollup")}
                </dt>
                <dd>
                  {checks
                    ? t(checkConclusionKey(checks.rollup))
                    : t("github.pull.noChecks")}
                </dd>
              </dl>
              <AlertDialogFooter>
                <AlertDialogCancel className="min-h-10">
                  {t("github.cancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  className="min-h-10"
                  disabled={busy}
                  onClick={() => {
                    setConfirm(false);
                    setOutcome(null);
                    if (chosen !== null) merge.mutate();
                  }}
                >
                  {t("github.merge")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}
