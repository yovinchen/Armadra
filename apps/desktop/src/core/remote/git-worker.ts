/**
 * Worker 这一侧的 Git 长操作进度：把队列里一个操作的快照变化推回控制端。
 *
 * 仓库服务只在内存里改 `progress` 与 `state`，没有「变了」的回调；本机的面板靠
 * 轮询 `GET …/operations/{id}` 读它。远端如果照搬，就是每次轮询一个往返。这里
 * 反过来：Worker 按 {@link TRACK_MS} 看一眼自己的队列，只在快照变了的时候推一帧
 * `git.operation`，结局那一帧之后停。控制端收到就更新镜像，面板照旧轮询，但读的
 * 是控制端内存里的镜像。
 */

import type { RepositoryService } from "../git/repository/service";
import { isTerminal, type OperationSnapshot } from "../git/repository/types";
import type { WorkerSession } from "./session";

/** 看一眼的间隔。进度条的分辨率，不是结局的延迟上限——结局那一刻就推。 */
export const TRACK_MS = 200;

function same(left: OperationSnapshot, right: OperationSnapshot): boolean {
  return (
    left.state === right.state &&
    left.progress === right.progress &&
    left.cancellationRequested === right.cancellationRequested &&
    left.message === right.message
  );
}

/** 开始跟踪 `id`，直到它进入终态或会话结束。 */
export function trackOperation(
  session: WorkerSession,
  service: RepositoryService,
  id: string,
): void {
  let last: OperationSnapshot | undefined;
  const look = (): boolean => {
    let snapshot: OperationSnapshot;
    try {
      snapshot = service.operationSnapshot(id);
    } catch {
      // 被挤出了历史：没有东西可报，也不会再有。
      return true;
    }
    if (last === undefined || !same(last, snapshot)) {
      last = snapshot;
      session.publish({ type: "git.operation", snapshot });
    }
    return isTerminal(snapshot.state);
  };
  if (look()) return;
  const timer = setInterval(() => {
    if (session.closed || look()) clearInterval(timer);
  }, TRACK_MS);
  timer.unref?.();
}
