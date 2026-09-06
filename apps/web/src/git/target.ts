import { useCanvasStore } from "../store/canvas-store";
import type { GitTarget } from "./gateway";

/**
 * 面板里「这一次读/写是关于哪个检出」的唯一算法。
 *
 * 两个口径必须同时给出，它们不是一回事：
 *  - `path` 是**工作空间相对**的目录，Runtime 自己那些路由收的就是它；
 *  - `repositoryPath` 是执行主机上的**绝对路径**，Host 按它串行——同一个
 *    worktree 一次只跑一个写——也按它判定检出在不在注册的工作空间根里。
 *
 * 混用过一次就是「暂存打到了另一个仓库」，所以拼接放在这一个地方。
 */
export function gitTarget(
  workspaceId: string,
  workspaceRoot: string | undefined,
  path = ".",
  repositoryId?: string,
): GitTarget {
  const relative = path.trim() === "" ? "." : path.trim();
  const root = (workspaceRoot ?? "").replace(/[\\/]+$/, "");
  return {
    workspaceId,
    // 拿不到工作空间根时原样交出相对路径。它在 Runtime 那侧照样能用，而
    // Host 那侧会因为它不是绝对路径而拒——这好过拼出一个假的绝对路径，让
    // 一次写落到某个碰巧同名的目录上。
    repositoryPath:
      relative === "." ? root || relative : root ? `${root}/${relative}` : relative,
    repositoryId,
    path: relative,
  };
}

/** 当前工作空间下某个检出的目标。组件里用这一个。 */
export function useGitTarget(
  workspaceId: string,
  path = ".",
  repositoryId?: string,
): GitTarget {
  const workspaceRoot = useCanvasStore((state) => state.workspace?.rootPath);
  return gitTarget(workspaceId, workspaceRoot, path, repositoryId);
}
