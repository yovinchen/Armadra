import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { create, GithubIssuePatchSchema } from "@armadra/protocol";
import {
  GithubReferenceKind,
  type GithubRepositoryRef,
  type HostGithubClient,
} from "@armadra/host-client";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { useT } from "@/app/preferences-store";
import { Field } from "../git/forms";
import { failureKey, instant, issueStateKey, pollInterval } from "./model";
import { ReferenceSection } from "./ReferenceSection";
import { githubKeys } from "./queries";

export interface IssueDetailProps {
  client: HostGithubClient;
  workspaceId: string;
  repository: GithubRepositoryRef;
  number: bigint;
  locale: string;
  canWrite: boolean;
  open: boolean;
  onBack: () => void;
}

/**
 * One Issue: body, comments and the references that tie it to this board.
 *
 * The body and every comment are remote text. They are rendered as text — no
 * markdown pipeline, no HTML — because they are material a person is reading,
 * not markup this page should execute or an instruction it should follow.
 */
export function IssueDetail({
  client,
  workspaceId,
  repository,
  number,
  locale,
  canWrite,
  open,
  onBack,
}: IssueDetailProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [comment, setComment] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [labels, setLabels] = React.useState("");
  const [assignees, setAssignees] = React.useState("");

  const detail = useQuery({
    queryKey: githubKeys.issue(workspaceId, repository, number),
    queryFn: () => client.getIssue({ repository, number }),
    enabled: open,
    retry: false,
    refetchInterval: (query) =>
      open ? pollInterval(query.state.data?.pollIntervalMs) : false,
  });

  const issue = detail.data?.issue;
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: githubKeys.all });
  const fail = (error: unknown) => toast.error(t(failureKey(error)));

  const postComment = useMutation({
    mutationFn: (text: string) =>
      client.commentIssue({ repository, number, body: text }),
    onSuccess: () => {
      setComment("");
      invalidate();
    },
    onError: fail,
  });

  const save = useMutation({
    mutationFn: () =>
      client.updateIssue({
        repository,
        number,
        patch: create(GithubIssuePatchSchema, {
          title: title.trim(),
          body,
          replaceLabels: true,
          labels: labels
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
          replaceAssignees: true,
          assignees: assignees
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        }),
        // The instant that was on screen: the Host re-reads before writing.
        expectedUpdatedAtUnixMs: issue!.updatedAtUnixMs,
      }),
    onSuccess: () => {
      setEditing(false);
      invalidate();
    },
    onError: fail,
  });

  function startEditing() {
    if (!issue) return;
    setTitle(issue.title);
    setBody(issue.body);
    setLabels(issue.labels.map((label) => label.name).join(", "));
    setAssignees(issue.assignees.map((user) => user.login).join(", "));
    setEditing(true);
  }

  return (
    <div className="min-w-0 space-y-3 p-3">
      <Button
        size="sm"
        variant="ghost"
        className="min-h-10"
        onClick={() => {
          setEditing(false);
          onBack();
        }}
      >
        {t("github.back")}
      </Button>

      {detail.isError && (
        <p role="status" className="text-[12px] text-destructive">
          {t(failureKey(detail.error))}
        </p>
      )}
      {!issue ? (
        detail.isPending ? (
          <p role="status" className="text-[12px] text-muted-foreground">
            {t("github.loading")}
          </p>
        ) : null
      ) : (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="shrink-0 tabular-nums text-muted-foreground">
              #{String(issue.number)}
            </span>
            <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium">
              {issue.title}
            </h3>
            <Badge variant="secondary">{t(issueStateKey(issue.state))}</Badge>
          </div>
          <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            <dt className="text-muted-foreground">
              {t("github.issue.updatedAt")}
            </dt>
            <dd className="min-w-0 truncate">
              {instant(issue.updatedAtUnixMs, locale) ??
                t("github.settings.unknown")}
            </dd>
            <dt className="text-muted-foreground">
              {t("github.issue.labels")}
            </dt>
            <dd className="min-w-0 truncate">
              {issue.labels.map((label) => label.name).join(", ")}
            </dd>
            <dt className="text-muted-foreground">
              {t("github.issue.assignees")}
            </dt>
            <dd className="min-w-0 truncate">
              {issue.assignees.map((user) => user.login).join(", ")}
            </dd>
          </dl>

          <p className="text-[11px] text-muted-foreground">
            {t("github.externalNote")}
          </p>
          <section className="min-w-0 space-y-1">
            <h4 className="text-[12px] font-medium text-muted-foreground">
              {t("github.issue.body")}
            </h4>
            <p className="min-w-0 break-words whitespace-pre-wrap text-[12px] select-text">
              {issue.body || t("github.issue.noBody")}
            </p>
          </section>

          <ReferenceSection
            client={client}
            workspaceId={workspaceId}
            repository={repository}
            kind={GithubReferenceKind.ISSUE}
            number={number}
            title={issue.title}
            references={detail.data!.references}
            canWrite={canWrite}
          />

          <section className="min-w-0 space-y-2">
            <h4 className="text-[12px] font-medium text-muted-foreground">
              {t("github.issue.comments")}
            </h4>
            {detail.data!.comments.map((entry) => (
              <article
                key={String(entry.id)}
                className="min-w-0 space-y-1 rounded-md border border-border px-3 py-2 text-[12px]"
              >
                <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
                  <span className="min-w-0 truncate">
                    {entry.author?.login}
                  </span>
                  <span className="min-w-0 truncate">
                    {instant(entry.createdAtUnixMs, locale)}
                  </span>
                </div>
                <p className="min-w-0 break-words whitespace-pre-wrap select-text">
                  {entry.body}
                </p>
              </article>
            ))}
          </section>

          {canWrite && (
            <section className="min-w-0 space-y-2 border-t border-border pt-3">
              <Textarea
                value={comment}
                rows={3}
                placeholder={t("github.issue.commentPlaceholder")}
                onChange={(event) => setComment(event.target.value)}
                className="min-w-0"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  className="min-h-10"
                  disabled={!comment.trim() || postComment.isPending}
                  onClick={() => postComment.mutate(comment)}
                >
                  {t("github.issue.comment")}
                </Button>
                {!editing && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-10"
                    onClick={startEditing}
                  >
                    {t("github.issue.edit")}
                  </Button>
                )}
              </div>
            </section>
          )}

          {canWrite && editing && (
            <form
              className="min-w-0 space-y-2 rounded-md border border-border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (title.trim()) save.mutate();
              }}
            >
              <Field label={t("github.create.title")}>
                <Input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  className="h-9 min-w-0"
                  required
                />
              </Field>
              <Field label={t("github.create.body")}>
                <Textarea
                  value={body}
                  rows={5}
                  onChange={(event) => setBody(event.target.value)}
                  className="min-w-0"
                />
              </Field>
              <Field label={t("github.create.labels")}>
                <Input
                  value={labels}
                  onChange={(event) => setLabels(event.target.value)}
                  className="h-9 min-w-0"
                />
              </Field>
              <Field label={t("github.create.assignees")}>
                <Input
                  value={assignees}
                  onChange={(event) => setAssignees(event.target.value)}
                  className="h-9 min-w-0"
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  size="sm"
                  className="min-h-10"
                  disabled={!title.trim() || save.isPending}
                >
                  {t("github.issue.save")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="min-h-10"
                  onClick={() => setEditing(false)}
                >
                  {t("github.cancel")}
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
