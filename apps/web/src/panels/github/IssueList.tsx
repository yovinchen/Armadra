import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { useT } from "@/app/preferences-store";
import { Freshness } from "./Freshness";
import { groupIssues, instant, issueStateKey } from "./model";
import type { IssuePage } from "./queries";
import {
  GithubIssue,
  GithubIssueState,
  GithubStatusMapping,
} from "../../api/github";

export interface MoveIssueRequest {
  issue: GithubIssue;
  toGroupId: string;
  fromGroupId: string;
  expectedUpdatedAtUnixMs: bigint;
  expectedMappingRevision: bigint;
}

export interface IssueListProps {
  page: IssuePage;
  mapping: GithubStatusMapping | undefined;
  locale: string;
  canWrite: boolean;
  busy: boolean;
  onOpen: (issue: GithubIssue) => void;
  onMove: (request: MoveIssueRequest) => void;
  onSetState: (issue: GithubIssue, state: GithubIssueState) => void;
}

/**
 * Issues under their configured status group (Git/GitHub design §7.2).
 *
 * `Move to…` sends the `updatedAt` and mapping revision that were on screen,
 * so the Host can refuse a move made against a stale view. Closing an Issue and
 * moving it into a Done group stay two separate actions here — coupling them
 * is a repository configuration, not a button.
 */
export function IssueList({
  page,
  mapping,
  locale,
  canWrite,
  busy,
  onOpen,
  onMove,
  onSetState,
}: IssueListProps) {
  const t = useT();
  const groups = groupIssues(page.issues, mapping);
  const revision = mapping?.revision ?? 0n;
  const targets = mapping?.groups ?? [];

  return (
    <div className="min-w-0 space-y-3 p-3">
      <Freshness meta={page} locale={locale} />
      {page.issues.length === 0 && (
        <p className="text-[12px] text-muted-foreground">
          {t("github.issues.empty")}
        </p>
      )}
      {page.statusGroupsPartial && page.issues.length > 0 && (
        <Badge
          variant="outline"
          data-slot="github-status-partial"
          title={t("github.issues.partialNote")}
        >
          {t("github.issues.partial")}
        </Badge>
      )}
      {groups.map((bucket) =>
        bucket.issues.length === 0 ? null : (
          <section key={bucket.id || "unmapped"} className="min-w-0 space-y-2">
            <h3 className="text-[12px] font-medium text-muted-foreground">
              {bucket.group ? bucket.group.title : t("github.issue.unmapped")}
            </h3>
            {bucket.issues.map((issue) => (
              <article
                key={String(issue.number)}
                data-slot="github-issue"
                data-issue-number={String(issue.number)}
                className="min-w-0 space-y-2 rounded-lg border border-border px-3 py-2"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    #{String(issue.number)}
                  </span>
                  <h4 className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {issue.title}
                  </h4>
                  <Badge variant="secondary">
                    {t(issueStateKey(issue.state))}
                  </Badge>
                  {issue.statusConflict && (
                    <Badge
                      variant="destructive"
                      title={t("github.issue.conflictNote")}
                    >
                      {t("github.issue.conflict")}
                    </Badge>
                  )}
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
                    {t("github.issue.comments")}
                  </dt>
                  <dd className="tabular-nums">{String(issue.commentCount)}</dd>
                </dl>
                {issue.labels.length > 0 && (
                  <div className="flex min-w-0 flex-wrap gap-1">
                    {issue.labels.map((label) => (
                      <Badge key={label.name} variant="outline">
                        {label.name}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="min-h-10"
                    onClick={() => onOpen(issue)}
                  >
                    {t("github.issue.open")}
                  </Button>
                  {/* 没有写权限或没有可用映射时这些控件不渲染，
                      而不是渲染成点了会 401 的禁用按钮。 */}
                  {canWrite && revision > 0n && targets.length > 0 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-10"
                          disabled={busy}
                        >
                          {t("github.issue.moveTo")}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="start"
                        className="z-[var(--z-menu)]"
                      >
                        {targets
                          .filter((group) => group.id !== issue.statusGroupId)
                          .map((group) => (
                            <DropdownMenuItem
                              key={group.id}
                              onSelect={() =>
                                onMove({
                                  issue,
                                  toGroupId: group.id,
                                  fromGroupId: issue.statusGroupId,
                                  expectedUpdatedAtUnixMs:
                                    issue.updatedAtUnixMs,
                                  expectedMappingRevision: revision,
                                })
                              }
                            >
                              {group.title}
                            </DropdownMenuItem>
                          ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  {canWrite && issue.state === GithubIssueState.OPEN && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="min-h-10"
                      disabled={busy}
                      onClick={() => onSetState(issue, GithubIssueState.CLOSED)}
                    >
                      {t("github.issue.close")}
                    </Button>
                  )}
                  {canWrite && issue.state === GithubIssueState.CLOSED && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="min-h-10"
                      disabled={busy}
                      onClick={() => onSetState(issue, GithubIssueState.OPEN)}
                    >
                      {t("github.issue.reopen")}
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </section>
        ),
      )}
    </div>
  );
}
