import { toast } from "sonner";
import type { GitRepositoryOperation } from "@armadra/shared";

import { t } from "../../../app/preferences-store";
import { gitGateway, type GitTarget } from "../../../git/gateway";
import { running } from "../operations";

/** 轮询间隔，与提交页跟随自己那一条写的节奏一致（`use-repository-writes.ts`）。 */
const POLL_MS = 600;

/** 有进度可报的三种网络命令用自己的名字，其余统称「操作状态」。 */
function actionLabel(operation: GitRepositoryOperation): string {
  switch (operation.action.kind) {
    case "fetch":
      return t("gitRepo.fetch");
    case "pull":
      return t("gitRepo.pull");
    case "push":
      return t("gitRepo.push");
    default:
      return t("gitRepo.operation");
  }
}

/**
 * 日志页交出去的一次写，跟到它结束：一条常驻提示写着状态与 `git --progress`
 * 报的百分比，带一个「取消」；结束时收起（成功）或换成结局（失败、已取消、
 * 结果不确定），并调 `onSettled` 重读。
 *
 * 以前日志页交出去就不管了——fetch 跑多久、到了哪儿都看不见，也没有地方取消，
 * 尽管 core 的队列与远端 Worker 都支持取消（typescript-core-status §44）。
 * 返回停止跟随的函数。
 */
export function followOperation(
  target: GitTarget,
  initial: GitRepositoryOperation,
  onSettled: () => void,
): () => void {
  const id = `git-operation-${initial.id}`;
  const label = actionLabel(initial);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const show = (operation: GitRepositoryOperation) => {
    const state = t(`gitRepo.state.${operation.state}`);
    const progress =
      operation.state === "running" && operation.progress > 0
        ? ` · ${operation.progress}%`
        : "";
    toast.loading(`${label} · ${state}${progress}`, {
      id,
      duration: Infinity,
      action: {
        label: t("gitRepo.cancel"),
        onClick: () => {
          void gitGateway.cancel(target, operation.id).catch(() => undefined);
        },
      },
    });
  };

  const finish = (operation: GitRepositoryOperation) => {
    stopped = true;
    switch (operation.state) {
      case "failed":
        toast.error(operation.message ?? t("gitRepo.failed"), { id });
        break;
      case "cancelled":
        toast.info(`${label} · ${t("gitRepo.state.cancelled")}`, { id });
        break;
      // 结果未知**不是**失败：渲染成失败会请人去做那件绝不能自动做的事。
      case "unknownOutcome":
        toast.warning(t("gitRepo.unknown"), { id });
        break;
      default:
        toast.dismiss(id);
    }
    onSettled();
  };

  const poll = () => {
    timer = setTimeout(() => {
      if (stopped) return;
      void gitGateway
        .operation(target, initial.id, initial.action)
        .then((operation) => {
          if (stopped) return;
          if (running(operation)) {
            show(operation);
            poll();
          } else finish(operation);
        })
        // 读不到这一条（core 重启、网络断了）：提示不能一直挂着转圈。
        .catch(() => {
          if (stopped) return;
          stopped = true;
          toast.dismiss(id);
          onSettled();
        });
    }, POLL_MS);
  };

  if (running(initial)) {
    show(initial);
    poll();
  } else finish(initial);

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
