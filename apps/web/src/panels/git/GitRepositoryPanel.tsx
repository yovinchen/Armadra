import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  GitBranchSnapshot,
  GitExpectedState,
  GitRepositoryAction,
  GitRepositoryOperation,
} from "@armadra/shared";
import { runtimeApi, RuntimeRequestError } from "../../api/client";
import { useT } from "../../app/preferences-store";
import { Button } from "../../ui/button";
import { ScrollArea } from "../../ui/scroll-area";
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
import { Branches } from "./Branches";
import { History } from "./History";
import { Worktrees } from "./Worktrees";
import { Stashes } from "./Stashes";
import { ReadError } from "./forms";
import { invalidateGitQueries } from "./queries";

export type RepositoryTab = "branches" | "history" | "worktrees" | "stashes";
const running = (operation: GitRepositoryOperation | null | undefined) =>
  operation?.state === "queued" || operation?.state === "running";
type Tracking = {
  operation: GitRepositoryOperation | null;
  pending: boolean;
  uncertain: boolean;
  error: string | null;
};
const emptyTracking: Tracking = {
  operation: null,
  pending: false,
  uncertain: false,
  error: null,
};

export function actionTarget(action: GitRepositoryAction): string {
  switch (action.kind) {
    case "createStash":
      return action.message || "Stash";
    case "applyStash":
    case "popStash":
    case "dropStash":
      return action.oid;
    case "fetch":
      return action.remote;
    case "pull":
    case "push":
      return `${action.remote} / ${action.branch}`;
    case "createBranch":
      return `${action.name} ← ${action.startPoint ?? "HEAD"}`;
    case "switchBranch":
    case "deleteBranch":
      return `${action.name} (${action.expectedOid})`;
    case "createWorktree":
      return `${action.path} · ${action.branch} ← ${action.createBranch ? (action.startPoint ?? "HEAD") : action.expectedOid}`;
    case "removeWorktree":
      return `${action.path} (${action.expectedOid})`;
  }
}

export function GitRepositoryPanel({
  workspaceId,
  tab,
}: {
  workspaceId: string;
  tab: RepositoryTab;
}) {
  const t = useT();
  const branches = useQuery({
    queryKey: ["git-repository-branches", workspaceId],
    queryFn: ({ signal }) =>
      runtimeApi.gitRepositoryBranches(workspaceId, signal),
    retry: false,
  });
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {branches.isPending && (
        <p role="status" className="p-3 text-xs">
          {t("gitRepo.loading")}
        </p>
      )}
      {branches.error && (
        <ReadError
          error={branches.error}
          retry={() => void branches.refetch()}
        />
      )}
      {branches.data && (
        <RepositorySession
          key={`${workspaceId}:${branches.data.repositoryId}:${branches.data.repositoryPath}`}
          workspaceId={workspaceId}
          tab={tab}
          snapshot={branches.data}
          stale={branches.isFetching || branches.isError}
        />
      )}
    </div>
  );
}

function RepositorySession({
  workspaceId,
  tab,
  snapshot,
  stale,
}: {
  workspaceId: string;
  tab: RepositoryTab;
  snapshot: GitBranchSnapshot;
  stale: boolean;
}) {
  const t = useT();
  const client = useQueryClient();
  const trackingKey = [
    "git-repository-active-operation",
    workspaceId,
    snapshot.repositoryId,
    snapshot.repositoryPath,
  ];
  const tracking = useQuery<Tracking>({
    queryKey: trackingKey,
    queryFn: async () => emptyTracking,
    initialData: emptyTracking,
    enabled: false,
    gcTime: Infinity,
  }).data;
  const updateTracking = (update: (current: Tracking) => Tracking) =>
    client.setQueryData<Tracking>(trackingKey, (current) =>
      update(current ?? emptyTracking),
    );
  const operationId = tracking.operation?.id;
  const recent = useQuery({
    queryKey: [
      "git-repository-operations",
      workspaceId,
      snapshot.repositoryId,
      snapshot.repositoryPath,
    ],
    queryFn: async ({ signal }) => {
      const items = await runtimeApi.gitRepositoryOperations(
        workspaceId,
        signal,
      );
      if (
        items.some(
          (item) =>
            item.repositoryId !== snapshot.repositoryId ||
            item.repositoryPath !== snapshot.repositoryPath,
        )
      )
        throw new Error(t("gitRepo.stale"));
      return items;
    },
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some(running) ? 1000 : false,
  });
  useEffect(() => {
    if (!recent.data?.length) return;
    const restored = recent.data.find(running) ?? recent.data[0];
    if (!restored) return;
    updateTracking((current) =>
      current.operation || current.pending || current.uncertain
        ? current
        : { ...current, operation: restored },
    );
    // This keyed component fixes the workspace and repository scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent.data]);
  const operationKey = [
    "git-repository-operation",
    workspaceId,
    snapshot.repositoryId,
    snapshot.repositoryPath,
    operationId,
  ];
  const operation = useQuery({
    queryKey: operationKey,
    queryFn: async ({ signal }) => {
      const result = await runtimeApi.gitRepositoryOperation(
        workspaceId,
        operationId!,
        signal,
      );
      if (
        result.repositoryId !== snapshot.repositoryId ||
        result.repositoryPath !== snapshot.repositoryPath ||
        result.id !== operationId
      )
        throw new Error(t("gitRepo.stale"));
      return result;
    },
    initialData: tracking.operation ?? undefined,
    enabled: Boolean(operationId) && running(tracking.operation),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) =>
      query.state.status !== "error" && running(query.state.data) ? 600 : false,
  });
  const invalidate = () => invalidateGitQueries(client, workspaceId);
  const lastInvalidated = useRef("");
  useEffect(() => {
    const result = operation.data;
    if (!result || result.id !== operationId) return;
    updateTracking((current) =>
      current.operation?.id === result.id
        ? { ...current, operation: result }
        : current,
    );
    if (
      !running(result) &&
      lastInvalidated.current !== `${result.id}:${result.state}`
    ) {
      lastInvalidated.current = `${result.id}:${result.state}`;
      invalidate();
    }
    // Scope and operation identity are captured by this keyed session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation.data, operationId]);
  const [confirmation, setConfirmation] = useState<{
    action: GitRepositoryAction;
    expected: GitExpectedState;
  } | null>(null);
  const submit = useMutation({
    mutationFn: async (input: {
      action: GitRepositoryAction;
      expected: GitExpectedState;
    }) => {
      const result = await runtimeApi.gitRepositoryOperate(
        workspaceId,
        input.action,
        input.expected,
      );
      if (
        result.repositoryId !== snapshot.repositoryId ||
        result.repositoryPath !== snapshot.repositoryPath
      )
        throw new Error(t("gitRepo.stale"));
      return result;
    },
    retry: false,
    onMutate: () =>
      updateTracking(() => ({
        operation: null,
        pending: true,
        uncertain: false,
        error: null,
      })),
    onSuccess: (result) => {
      client.setQueryData(
        [
          "git-repository-operation",
          workspaceId,
          snapshot.repositoryId,
          snapshot.repositoryPath,
          result.id,
        ],
        result,
      );
      updateTracking(() => ({
        operation: result,
        pending: false,
        uncertain: false,
        error: null,
      }));
    },
    onError: (error) => {
      updateTracking(() => ({
        operation: null,
        pending: false,
        uncertain: !(
          error instanceof RuntimeRequestError && error.status < 500
        ),
        error: error.message,
      }));
      invalidate();
    },
  });
  const cancel = useMutation({
    mutationFn: async (id: string) => {
      const result = await runtimeApi.gitRepositoryCancel(workspaceId, id);
      if (
        result.repositoryId !== snapshot.repositoryId ||
        result.repositoryPath !== snapshot.repositoryPath ||
        result.id !== id
      )
        throw new Error(t("gitRepo.stale"));
      return result;
    },
    retry: false,
    onSuccess: (result) =>
      client.setQueryData(
        [
          "git-repository-operation",
          workspaceId,
          snapshot.repositoryId,
          snapshot.repositoryPath,
          result.id,
        ],
        result,
      ),
  });
  const current =
    operation.data?.id === operationId ? operation.data : tracking.operation;
  const busy =
    tracking.pending ||
    tracking.uncertain ||
    running(current) ||
    Boolean(recent.data?.some(running));
  const request = (
    action: GitRepositoryAction,
    expected?: GitExpectedState,
  ) => {
    if (!busy && !stale)
      setConfirmation({ action, expected: { ...(expected ?? snapshot.head) } });
  };
  return (
    <>
      <div className="max-h-[40dvh] shrink-0 space-y-2 overflow-y-auto border-b border-border p-3 text-xs">
        <Button size="sm" variant="outline" onClick={invalidate}>
          {t("gitRepo.refresh")}
        </Button>
        {recent.error && (
          <ReadError error={recent.error} retry={() => void recent.refetch()} />
        )}
        {Boolean(recent.data?.length) && (
          <details>
            <summary className="cursor-pointer">
              {t("gitRepo.recentOperations")}
            </summary>
            <div className="max-h-36 space-y-1 overflow-y-auto py-2">
              {recent.data?.map((item) => (
                <Button
                  key={item.id}
                  variant="ghost"
                  size="sm"
                  className="h-auto w-full justify-start whitespace-normal text-left"
                  disabled={tracking.pending || tracking.uncertain}
                  onClick={() =>
                    updateTracking((current) => ({
                      ...current,
                      operation: item,
                    }))
                  }
                >
                  {t(`gitRepo.${item.action.kind}`)} ·{" "}
                  {t(`gitRepo.state.${item.state}`)} ·{" "}
                  {actionTarget(item.action)}
                </Button>
              ))}
            </div>
          </details>
        )}
        {tracking.pending && <p role="status">{t("gitRepo.submitting")}</p>}
        {tracking.error && (
          <p role="alert" className="break-words text-destructive">
            {tracking.error}
          </p>
        )}
        {(tracking.uncertain || current?.state === "unknownOutcome") && (
          <p role="alert">{t("gitRepo.unknown")}</p>
        )}
        {tracking.uncertain && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              updateTracking((current) => ({
                ...current,
                uncertain: false,
                error: null,
              }))
            }
          >
            {t("gitRepo.reviewed")}
          </Button>
        )}
        {current && (
          <section aria-label={t("gitRepo.operation")} className="space-y-1">
            <p role="status">
              {t(`gitRepo.${current.action.kind}`)} ·{" "}
              {t(`gitRepo.state.${current.state}`)}
            </p>
            <p className="break-all text-muted-foreground">
              {actionTarget(current.action)}
            </p>
            <details>
              <summary className="cursor-pointer">
                {t("gitRepo.operationId")}
              </summary>
              <p className="break-all font-mono">{current.id}</p>
            </details>
            {current.message && (
              <p className="break-words">{current.message}</p>
            )}
            {current.cancellationRequested && running(current) && (
              <p>{t("gitRepo.cancelRequested")}</p>
            )}
            {running(current) && (
              <Button
                size="sm"
                variant="outline"
                disabled={cancel.isPending || current.cancellationRequested}
                onClick={() => cancel.mutate(current.id)}
              >
                {t("gitRepo.cancelOperation")}
              </Button>
            )}
          </section>
        )}
        {cancel.error && (
          <p role="alert" className="break-words text-destructive">
            {cancel.error.message}
          </p>
        )}
        {operation.error && (
          <div role="alert" className="space-y-1">
            <p>{t("gitRepo.pollFailed")}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void operation.refetch()}
            >
              {t("gitRepo.checkOperation")}
            </Button>
          </div>
        )}
      </div>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        {tab === "branches" && (
          <Branches
            snapshot={snapshot}
            busy={busy || stale}
            request={request}
          />
        )}
        {tab === "history" && (
          <History
            workspaceId={workspaceId}
            repositoryKey={`${snapshot.repositoryId}:${snapshot.repositoryPath}`}
          />
        )}
        {tab === "stashes" && (
          <Stashes
            workspaceId={workspaceId}
            repositoryKey={`${snapshot.repositoryId}:${snapshot.repositoryPath}`}
            busy={busy || stale}
            request={request}
            loadSnapshot={(signal) =>
              runtimeApi.gitRepositoryStashes(workspaceId, signal)
            }
            loadDetail={(oid, signal) =>
              runtimeApi.gitRepositoryStashDetail(workspaceId, oid, signal)
            }
          />
        )}
        {tab === "worktrees" && (
          <Worktrees
            workspaceId={workspaceId}
            repositoryKey={`${snapshot.repositoryId}:${snapshot.repositoryPath}`}
            branches={snapshot.branches}
            busy={busy || stale}
            request={request}
          />
        )}
      </ScrollArea>
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("gitRepo.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("gitRepo.confirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmation && (
            <dl className="space-y-2 break-all text-xs">
              {confirmation.action.kind === "createStash" && (
                <div>
                  <dt>{t("gitStash.safety")}</dt>
                  <dd>
                    {confirmation.action.includeUntracked ? "✓ " : "— "}
                    {t("gitStash.includeUntracked")}
                  </dd>
                </div>
              )}
              {(confirmation.action.kind === "applyStash" ||
                confirmation.action.kind === "popStash") && (
                <div>
                  <dt>{t("gitStash.conflictSafety")}</dt>
                  <dd>
                    {confirmation.action.reinstateIndex ? "✓ " : "— "}
                    {t("gitStash.reinstateIndex")}
                  </dd>
                </div>
              )}
              {(confirmation.action.kind === "popStash" ||
                confirmation.action.kind === "dropStash") && (
                <div>
                  <dd>{t("gitStash.dropSafety")}</dd>
                </div>
              )}
              <div>
                <dt className="text-muted-foreground">
                  {t("gitRepo.repository")}
                </dt>
                <dd>{snapshot.repositoryPath}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t(`gitRepo.${confirmation.action.kind}`)}
                </dt>
                <dd>{actionTarget(confirmation.action)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("gitRepo.head")}</dt>
                <dd>
                  {confirmation.expected.branch ?? t("gitRepo.detached")} ·{" "}
                  {confirmation.expected.headOid ?? t("gitRepo.unborn")}
                </dd>
              </div>
            </dl>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("gitRepo.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || stale}
              onClick={() => {
                if (confirmation && !busy && !stale) {
                  submit.mutate(confirmation);
                  setConfirmation(null);
                }
              }}
            >
              {t("gitRepo.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
