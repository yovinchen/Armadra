import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  GitHunk,
  GitHunkAction,
  GitHunkDiff,
  GitHunkMutation,
  GitHunkResult,
  GitHunkScope,
} from "@armadra/shared";
import { useT } from "../../app/preferences-store";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";

export interface ChangesHunksProps {
  workspaceId: string;
  /**
   * 文件所在的**检出**，工作空间相对，`"."` 是根。缺省是根：源码控制抽屉里的
   * hunk 视图只服务根仓库，那个调用点不必跟着改。
   */
  repositoryPath?: string;
  /** 仓库相对的文件路径——同名文件在两个检出里是两个文件。 */
  file: string;
  scope: GitHunkScope;
  load: (
    workspaceId: string,
    file: string,
    scope: GitHunkScope,
    signal?: AbortSignal,
    repositoryPath?: string,
  ) => Promise<GitHunkDiff>;
  apply: (
    workspaceId: string,
    request: GitHunkMutation,
  ) => Promise<GitHunkResult>;
  onChanged?: (workspaceId: string, file: string, scope: GitHunkScope) => void;
}

/** A scope change unmounts pending dialogs and local result state. */
export function ChangesHunks(props: ChangesHunksProps) {
  return (
    <HunkSession
      key={`${props.workspaceId}:${props.repositoryPath ?? "."}:${props.file}:${props.scope}`}
      {...props}
    />
  );
}

function HunkBody({ hunk }: { hunk: GitHunk }) {
  return (
    <pre className="max-h-64 min-w-0 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-5">
      <code>
        {hunk.header}
        {"\n"}
        {hunk.content}
      </code>
    </pre>
  );
}

const reasons = new Set([
  "binary",
  "notTrackedModification",
  "modeChange",
  "notRegularFile",
  "filter",
  "nonUtf8",
  "unsupportedPatch",
]);
function HunkSession({
  workspaceId,
  repositoryPath = ".",
  file,
  scope,
  load,
  apply,
  onChanged,
}: ChangesHunksProps) {
  const t = useT();
  const client = useQueryClient();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const query = useQuery({
    // 检出路径必须进键：两个仓库里的同名文件是两份差异，共用一个键会把别人的
    // hunk 当成自己的显示出来，连带那份 `diffDigest` 也是别人的。
    queryKey: ["git-hunks", workspaceId, repositoryPath, file, scope],
    queryFn: async ({ signal }) => {
      const value = await load(
        workspaceId,
        file,
        scope,
        signal,
        repositoryPath,
      );
      if (value.file !== file || value.scope !== scope)
        throw new Error(t("gitHunk.invalidResponse"));
      return value;
    },
    retry: false,
  });
  const [confirmation, setConfirmation] = useState<{
    hunk: GitHunk;
    digest: string;
  } | null>(null);
  const mutation = useMutation({
    mutationFn: async (request: GitHunkMutation) => {
      const result = await apply(workspaceId, request);
      if (
        !result.applied ||
        result.file !== file ||
        result.scope !== scope ||
        result.action !== request.action ||
        result.hunkId !== request.hunkId
      )
        throw new Error(t("gitHunk.invalidResponse"));
      return result;
    },
    retry: false,
    onSettled: async () => {
      await Promise.all(
        [
          "git-status",
          "git-diff",
          "git-hunks",
          "git-repository-branches",
          "git-repository-history",
          "git-repository-worktrees",
        ].map((key) =>
          client.invalidateQueries({ queryKey: [key, workspaceId] }),
        ),
      );
      if (active.current) onChanged?.(workspaceId, file, scope);
    },
  });
  const busy = mutation.isPending || query.isFetching;
  const execute = (
    hunk: GitHunk,
    action: GitHunkAction,
    digest = query.data?.diffDigest,
  ) => {
    if (busy || query.isError || !query.data?.supported || !digest) return;
    mutation.mutate({
      path: repositoryPath,
      file,
      scope,
      diffDigest: digest,
      hunkId: hunk.id,
      action,
    });
  };
  const confirmationCurrent =
    confirmation &&
    !query.isError &&
    query.data?.supported &&
    confirmation.digest === query.data.diffDigest &&
    query.data.hunks.some((hunk) => hunk.id === confirmation.hunk.id);
  return (
    <section aria-label={t("gitHunk.title")} className="min-w-0 space-y-3 p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 break-all text-xs font-medium">{file}</h3>
        <Badge variant="outline">
          {t(scope === "staged" ? "gitHunk.staged" : "gitHunk.worktree")}
        </Badge>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void query.refetch()}
      >
        {t("gitHunk.reload")}
      </Button>
      {query.isPending && (
        <p role="status" className="text-xs">
          {t("gitHunk.loading")}
        </p>
      )}
      {query.error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {query.error.message}
        </p>
      )}
      {mutation.isPending && (
        <p role="status" className="text-xs">
          {t("gitHunk.busy")}
        </p>
      )}
      {mutation.error && (
        <div
          role="alert"
          className="space-y-1 break-words text-xs text-destructive"
        >
          <p>{mutation.error.message || t("gitHunk.failed")}</p>
          <p>{t("gitHunk.uncertain")}</p>
        </div>
      )}
      {mutation.isSuccess && (
        <p role="status" className="text-xs">
          {t("gitHunk.applied")}
        </p>
      )}
      {query.data && !query.data.supported && (
        <p className="text-xs text-muted-foreground">
          {t(
            query.data.unsupportedReason &&
              reasons.has(query.data.unsupportedReason)
              ? `gitHunk.unsupported.${query.data.unsupportedReason}`
              : "gitHunk.unsupported",
          )}
        </p>
      )}
      {query.data?.supported &&
        query.data.hunks.map((hunk) => (
          <section
            key={hunk.id}
            className="min-w-0 space-y-2 rounded-md border border-border p-2"
          >
            <HunkBody hunk={hunk} />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy || query.isError}
                onClick={() =>
                  execute(hunk, scope === "staged" ? "unstage" : "stage")
                }
              >
                {t(scope === "staged" ? "gitHunk.unstage" : "gitHunk.stage")}
              </Button>
              {scope === "worktree" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || query.isError}
                  onClick={() =>
                    setConfirmation({ hunk, digest: query.data!.diffDigest })
                  }
                >
                  {t("gitHunk.revert")}
                </Button>
              )}
            </div>
          </section>
        ))}
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("gitHunk.revertTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("gitHunk.revertDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="break-all text-xs font-medium">{file}</p>
          {confirmation && <HunkBody hunk={confirmation.hunk} />}
          {!confirmationCurrent && (
            <p role="alert" className="text-xs">
              {t("gitHunk.stale")}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("gitHunk.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !confirmationCurrent}
              onClick={() => {
                if (confirmation && confirmationCurrent && !busy) {
                  execute(confirmation.hunk, "revert", confirmation.digest);
                  setConfirmation(null);
                }
              }}
            >
              {t("gitHunk.revert")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
