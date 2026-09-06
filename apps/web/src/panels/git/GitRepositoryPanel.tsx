import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  GitBranchSnapshot,
  GitCherryPickPreview,
  GitIntegrationSnapshot,
  GitExpectedState,
  GitRepositoryAction,
  GitRepositoryOperation,
} from "@armadra/shared";
import { RuntimeRequestError } from "../../api/client";
import { gitGateway, type GitTarget } from "../../git/gateway";
import { useGitTarget } from "../../git/target";
import { useT } from "../../app/preferences-store";
import { Button } from "../../ui/button";
import { ScrollArea } from "../../ui/scroll-area";
import { Branches } from "./Branches";
import { History } from "./History";
import { Tags } from "./Tags";
import { Remotes } from "./Remotes";
import { Worktrees } from "./Worktrees";
import { Stashes } from "./Stashes";
import { Integrations } from "./Integrations";
import { useCanvasStore } from "../../store/canvas-store";
import { nodeDropPosition } from "@/canvas/placement";
import { ReadError } from "./forms";
import { invalidateGitQueries } from "./queries";
import { RepositoryConfirmDialog } from "./RepositoryConfirmDialog";
import {
  actionTarget,
  emptyTracking,
  mergeOperation,
  running,
  type Confirmation,
  type RepositoryTab,
  type Tracking,
} from "./operations";

export { actionTarget } from "./operations";
export type { RepositoryTab } from "./operations";

export function GitRepositoryPanel({
  workspaceId,
  tab,
  repositoryPath = ".",
}: {
  workspaceId: string;
  tab: RepositoryTab;
  /**
   * 工作空间下的哪个仓库（roadmap §4.1）。缺省是工作空间根，所以单仓库的
   * 工作空间行为和以前完全一样。
   */
  repositoryPath?: string;
}) {
  const t = useT();
  // 每一次读都经网关，和写走同一条归属判定。切到 Host 之后直连 Runtime 的读
  // 读的是「那台 Runtime 眼里的仓库」，而写排在 Host 的队列上——同一个面板
  // 里两半数据来自两侧，正是「暂存了却看不到」这类报告的来源。
  const lookup = useGitTarget(workspaceId, repositoryPath);
  const branches = useQuery({
    queryKey: ["git-repository-branches", workspaceId, repositoryPath],
    queryFn: ({ signal }) => gitGateway.branches(lookup, signal),
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
          key={`${workspaceId}:${repositoryPath}:${branches.data.repositoryId}`}
          workspaceId={workspaceId}
          tab={tab}
          repositoryPath={repositoryPath}
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
  repositoryPath,
  snapshot,
  stale,
}: {
  workspaceId: string;
  tab: RepositoryTab;
  repositoryPath: string;
  snapshot: GitBranchSnapshot;
  stale: boolean;
}) {
  const t = useT();
  const client = useQueryClient();
  // 检出的身份取自快照本身，而不是把工作空间根和相对路径再拼一次：那份绝对
  // 路径是执行主机自己解析出来的，也正是 Host 用来串行的那一个键。
  const target: GitTarget = {
    workspaceId,
    repositoryPath: snapshot.repositoryPath,
    repositoryId: snapshot.repositoryId,
    path: repositoryPath,
  };
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
  const operationQueryKey = (id: string | undefined) => [
    "git-repository-operation",
    workspaceId,
    snapshot.repositoryId,
    snapshot.repositoryPath,
    id,
  ];
  const recentKey = [
    "git-repository-operations",
    workspaceId,
    snapshot.repositoryId,
    snapshot.repositoryPath,
  ];
  const latestOperation = (incoming: GitRepositoryOperation) => {
    const cached = client.getQueryData<GitRepositoryOperation>(
      operationQueryKey(incoming.id),
    );
    const tracked = client.getQueryData<Tracking>(trackingKey)?.operation;
    const previous =
      tracked?.id === incoming.id ? mergeOperation(cached, tracked) : cached;
    return mergeOperation(previous, incoming);
  };
  /**
   * 打开仓库里的一个文件。路径是**相对被选中的那个仓库**的，所以要拼上这个
   * 仓库自己的顶层路径——嵌套仓库里的 `src/main.rs` 和根仓库里的同名文件
   * 不是同一个文件。
   */
  const openRepositoryFile = (path: string) => {
    const store = useCanvasStore.getState();
    if (store.workspace?.id !== workspaceId || !store.document) return;
    store.addNode("editor", {
      title: path,
      data: {
        path: `${snapshot.repositoryPath.replace(/[\\/]+$/, "")}/${path}`,
      },
      position: nodeDropPosition("editor"),
    });
    store.setPanel("scm", "closed");
  };
  const acceptOperation = (incoming: GitRepositoryOperation) => {
    const result = latestOperation(incoming);
    client.setQueryData(operationQueryKey(result.id), result);
    return result;
  };
  const recent = useQuery({
    queryKey: recentKey,
    queryFn: async ({ signal }) => {
      const items = await gitGateway.operations(target, signal);
      if (
        items.some(
          (item) =>
            item.repositoryId !== snapshot.repositoryId ||
            item.repositoryPath !== snapshot.repositoryPath,
        )
      )
        throw new Error(t("gitRepo.stale"));
      return items.map(latestOperation);
    },
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some(running) ? 1000 : false,
  });
  useEffect(() => {
    if (!recent.data?.length) return;
    const items = recent.data.map(acceptOperation);
    if (items.some((item, index) => item !== recent.data![index]))
      client.setQueryData(recentKey, items);
    const restored = items.find(running) ?? items[0];
    if (!restored) return;
    updateTracking((current) => {
      if (current.pending || current.uncertain) return current;
      if (current.operation) {
        const observed = items.find(
          (item) => item.id === current.operation!.id,
        );
        if (!observed) return current;
        const next = mergeOperation(current.operation, observed);
        return next === current.operation
          ? current
          : { ...current, operation: next };
      }
      return { ...current, operation: restored };
    });
    // This keyed component fixes the workspace and repository scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent.data]);
  const operationKey = operationQueryKey(operationId);
  const operation = useQuery({
    queryKey: operationKey,
    queryFn: async ({ signal }) => {
      const result = await gitGateway.operation(
        target,
        operationId!,
        tracking.operation?.action ?? lastRequested.current!,
        signal,
      );
      if (
        result.repositoryId !== snapshot.repositoryId ||
        result.repositoryPath !== snapshot.repositoryPath ||
        result.id !== operationId
      )
        throw new Error(t("gitRepo.stale"));
      return latestOperation(result);
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
  // Host 的队列记录存的是版本锁字节，不是解析过的动作。轮询与取消回填的就是
  // 调用方刚发出去的那一份，而不是去猜——猜出来的动作会在面板上显示成另一条
  // 命令。
  const lastRequested = useRef<GitRepositoryAction | null>(null);
  useEffect(() => {
    const incoming = operation.data;
    if (!incoming || incoming.id !== operationId) return;
    const result = acceptOperation(incoming);
    updateTracking((current) =>
      current.operation?.id === result.id
        ? { ...current, operation: mergeOperation(current.operation, result) }
        : current,
    );
    if (
      !running(result) &&
      lastInvalidated.current !==
        `${result.id}:${result.state}:${result.finishedAt ?? ""}`
    ) {
      lastInvalidated.current = `${result.id}:${result.state}:${result.finishedAt ?? ""}`;
      invalidate();
    }
    // Scope and operation identity are captured by this keyed session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation.data, operationId]);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  // Overwriting published history takes a second, separate acknowledgement of
  // the exact remote commit the lease replaces.
  const [acknowledged, setAcknowledged] = useState(false);
  const submit = useMutation({
    mutationFn: async (input: {
      action: GitRepositoryAction;
      expected: GitExpectedState;
    }) => {
      lastRequested.current = input.action;
      // 一次按钮一个种子。Host 认得出同一个种子是重放，所以它必须每次意图各
      // 不相同——「再按一次」是第二个决定，不是同一个决定的重试。
      const result = await gitGateway.operate(
        target,
        input.action,
        input.expected,
        `${snapshot.repositoryId}/${crypto.randomUUID()}`,
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
    onSuccess: (incoming) => {
      const result = acceptOperation(incoming);
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
      const result = await gitGateway.cancel(
        target,
        id,
        tracking.operation?.action ?? lastRequested.current!,
        `cancel/${id}`,
      );
      if (
        result.repositoryId !== snapshot.repositoryId ||
        result.repositoryPath !== snapshot.repositoryPath ||
        result.id !== id
      )
        throw new Error(t("gitRepo.stale"));
      return result;
    },
    retry: false,
    onSuccess: (result) => {
      acceptOperation(result);
    },
  });
  const current =
    operation.data && operation.data.id === operationId
      ? mergeOperation(tracking.operation, operation.data)
      : tracking.operation;
  const busy =
    tracking.pending ||
    tracking.uncertain ||
    running(current) ||
    Boolean(recent.data?.some(running));
  const request = (
    action: GitRepositoryAction,
    expected?: GitExpectedState,
  ) => {
    if (busy || stale) return;
    let review:
      | { oid: string; mainline: number | null; parentOid: string | null }
      | undefined;
    if (action.kind === "startCherryPick") {
      const preview = client.getQueryData<GitCherryPickPreview>([
        "git-cherry-pick-preview",
        workspaceId,
        `${snapshot.repositoryId}:${snapshot.repositoryPath}`,
        action.targetOid,
        action.mainline,
      ]);
      review = {
        oid: action.targetOid,
        mainline: action.mainline,
        parentOid:
          action.mainline && preview?.targetOid === action.targetOid
            ? (preview.parents[action.mainline - 1] ?? null)
            : null,
      };
    } else if (
      action.kind === "continueIntegration" ||
      action.kind === "abortIntegration" ||
      action.kind === "skipIntegration"
    ) {
      const observed = client.getQueryData<GitIntegrationSnapshot>([
        "git-repository-integration",
        workspaceId,
        `${snapshot.repositoryId}:${snapshot.repositoryPath}`,
      ]);
      if (
        observed?.sessionId === action.sessionId &&
        observed.stateToken === action.expectedStateToken &&
        observed.targetOid
      )
        review = {
          oid: observed.targetOid,
          mainline: observed.mainline,
          parentOid: null,
        };
    }
    setAcknowledged(false);
    setConfirmation({
      action,
      expected: { ...(expected ?? snapshot.head) },
      review,
    });
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
                      operation: acceptOperation(item),
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
            target={target}
            busy={busy || stale}
            request={request}
            openFile={openRepositoryFile}
            loadIntegration={(signal) => gitGateway.integration(target, signal)}
          />
        )}
        {tab === "integration" && (
          <Integrations
            workspaceId={workspaceId}
            repositoryKey={`${snapshot.repositoryId}:${snapshot.repositoryPath}`}
            branches={snapshot.branches}
            busy={busy || stale}
            request={request}
            loadSnapshot={(signal) => gitGateway.integration(target, signal)}
            loadCherryPick={(oid, mainline, signal) =>
              gitGateway.cherryPickPreview(target, oid, mainline, signal)
            }
            loadRebaseTodo={(onto, signal) =>
              gitGateway.rebaseTodo(target, onto, signal)
            }
            markResolved={(path) =>
              gitGateway.markResolved(
                target,
                [path],
                `resolve/${snapshot.repositoryId}/${path}`,
              )
            }
            openFile={openRepositoryFile}
          />
        )}
        {tab === "stashes" && (
          <Stashes
            workspaceId={workspaceId}
            repositoryKey={`${snapshot.repositoryId}:${snapshot.repositoryPath}`}
            busy={busy || stale}
            request={request}
            loadSnapshot={(signal) => gitGateway.stashes(target, signal)}
            loadDetail={(oid, signal) =>
              gitGateway.stashDetail(target, oid, signal)
            }
          />
        )}
        {tab === "tags" && (
          <Tags
            workspaceId={workspaceId}
            repositoryKey={`${snapshot.repositoryId}:${snapshot.repositoryPath}`}
            remotes={snapshot.remotes}
            busy={busy || stale}
            request={request}
            loadTags={(signal) => gitGateway.tags(target, signal)}
          />
        )}
        {tab === "remotes" && (
          <Remotes
            workspaceId={workspaceId}
            repositoryKey={`${snapshot.repositoryId}:${snapshot.repositoryPath}`}
            busy={busy || stale}
            request={request}
            loadRemotes={(signal) => gitGateway.remotes(target, signal)}
          />
        )}
        {tab === "worktrees" && (
          <Worktrees
            workspaceId={workspaceId}
            repositoryKey={`${snapshot.repositoryId}:${snapshot.repositoryPath}`}
            target={target}
            branches={snapshot.branches}
            busy={busy || stale}
            request={request}
          />
        )}
      </ScrollArea>
      <RepositoryConfirmDialog
        confirmation={confirmation}
        setConfirmation={setConfirmation}
        acknowledged={acknowledged}
        setAcknowledged={setAcknowledged}
        blocked={busy || stale}
        repositoryPath={snapshot.repositoryPath}
        submit={submit.mutate}
      />
    </>
  );
}
