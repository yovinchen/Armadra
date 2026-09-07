/**
 * 提交页那些**要先确认**的写：横幅上的继续 / 跳过 / 中止、两个 Stash 对话框、
 * 提交并推送里的推送。
 *
 * 它们和逐文件的暂存不是一回事：暂存改的是索引，撤回只要再点一次；这些改的是
 * 分支与远端，所以每一次都要经 `RepositoryConfirmDialog` 复述一遍，并且一次只
 * 排一条——同一个检出上两条命令并行，Git 自己的锁会拒掉第二条，而那时候用户
 * 已经以为两条都排上了。
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { GitRepositoryOperation } from "@armadra/shared";
import { gitGateway } from "../../../git/gateway";
import { gitTarget } from "../../../git/target";
import { useT } from "../../../app/preferences-store";
import { useCanvasStore } from "../../../store/canvas-store";
import { running } from "../operations";
import { invalidateGitQueries } from "../queries";
import type { RepositoryRequest } from "../actions/integration";

/** 一条等着被确认的写：动作、被比对的 HEAD，以及它作用于哪个检出。 */
export interface QueuedRequest extends RepositoryRequest {
  /**
   * 这一条自己的身份。确认框关闭时会**不止一次**说「关掉当前这条」（按钮自己
   * 关一次，Radix 的 onOpenChange 再说一次），按身份撤销才不会顺手把队列里的
   * 下一条也一起丢掉。
   */
  id: string;
  /** 工作空间相对路径。 */
  repositoryPath: string;
}

export interface RepositoryWrites {
  /** 排队等确认的第一条；确认框显示的就是它。 */
  confirmation: QueuedRequest | null;
  request: (repositoryPath: string, request: RepositoryRequest) => void;
  /** 撤销队首的那一条；`id` 对不上就什么都不做。 */
  dismiss: (id: string) => void;
  submit: () => void;
  /** 有写在排队、在跑，或者刚提交完还没收到结论。 */
  busy: boolean;
  operation: GitRepositoryOperation | null;
  acknowledged: boolean;
  setAcknowledged: (next: boolean) => void;
}

export function useRepositoryWrites(workspaceId: string): RepositoryWrites {
  const t = useT();
  const client = useQueryClient();
  const workspaceRoot = useCanvasStore((state) => state.workspace?.rootPath);
  const [queue, setQueue] = useState<QueuedRequest[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [tracked, setTracked] = useState<{
    operation: GitRepositoryOperation;
    repositoryPath: string;
  } | null>(null);
  const submitted = useMutation({
    mutationFn: async (queued: QueuedRequest) => {
      const target = gitTarget(
        workspaceId,
        workspaceRoot,
        queued.repositoryPath,
      );
      // 一次按钮一个种子：Host 认得出同一个种子是重放，所以「再按一次」必须
      // 是第二个决定，而不是同一个决定的重试。
      return gitGateway.operate(
        target,
        queued.action,
        queued.expected,
        `commit-page/${queued.repositoryPath}/${crypto.randomUUID()}`,
      );
    },
    retry: false,
    onSuccess: (operation, queued) => {
      setTracked({ operation, repositoryPath: queued.repositoryPath });
      invalidateGitQueries(client, workspaceId);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : t("gitRepo.failed")),
  });
  const poll = useQuery({
    queryKey: [
      "git-repository-operation",
      workspaceId,
      tracked?.repositoryPath,
      tracked?.operation.id,
    ],
    queryFn: ({ signal }) =>
      gitGateway.operation(
        gitTarget(workspaceId, workspaceRoot, tracked!.repositoryPath),
        tracked!.operation.id,
        tracked!.operation.action,
        signal,
      ),
    enabled: Boolean(tracked) && running(tracked?.operation),
    initialData: tracked?.operation,
    retry: false,
    refetchInterval: (query) => (running(query.state.data) ? 600 : false),
  });
  useEffect(() => {
    const observed = poll.data;
    if (!observed || !tracked || observed.id !== tracked.operation.id) return;
    if (observed.state === tracked.operation.state) return;
    setTracked({ ...tracked, operation: observed });
    if (running(observed)) return;
    invalidateGitQueries(client, workspaceId);
    if (observed.state === "failed")
      toast.error(observed.message ?? t("gitRepo.failed"));
    // 结果未知**不是**失败：把它渲染成失败会请人去做那件绝不能自动做的事。
    else if (observed.state === "unknownOutcome")
      toast.warning(t("gitRepo.unknown"));
    // 依赖只写观察到的那一条：仓库范围由这个工作空间固定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll.data]);
  const operation = tracked?.operation ?? null;
  return {
    confirmation: queue[0] ?? null,
    request: (repositoryPath, request) => {
      setAcknowledged(false);
      setQueue((current) => [
        ...current,
        { ...request, repositoryPath, id: crypto.randomUUID() },
      ]);
    },
    dismiss: (id) =>
      setQueue((current) =>
        current[0]?.id === id ? current.slice(1) : current,
      ),
    submit: () => {
      const queued = queue[0];
      // 队首在确认框关闭时被撤走；这里只负责把它送出去。
      if (!queued || submitted.isPending || running(operation)) return;
      submitted.mutate(queued);
    },
    busy: submitted.isPending || running(operation),
    operation,
    acknowledged,
    setAcknowledged,
  };
}
