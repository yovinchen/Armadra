import type { CanvasNode, FrameBinding, Position } from "@armadra/shared";

import {
  boundFrameForPath,
  normalizePath,
} from "../../../canvas/frame-binding";
import type { CanvasStore } from "../../../store/canvas/types";

/**
 * 「在 Frame 里打开这条 worktree」（roadmap §3.4 G03，Git 工具窗口设计 §2.2）。
 *
 * 两个口径在这里对齐，混用过一次就是「Frame 指向一个不存在的目录」：分支树上
 * 的 `path` 是 **git 交出的绝对路径**，而 `FrameBinding.worktreePath` 记的是
 * **工作区相对路径**（`canvas/frame-binding.ts` 文件头）。
 *
 * 画布只经 `canvas-store` 的动作改；这里不直接碰 document。
 */

/** 绑定 Frame 的默认尺寸：装得下一个默认终端还留出边距。 */
export const WORKTREE_FRAME_SIZE = { width: 720, height: 560 };

/**
 * 绝对路径换回工作区相对路径。
 *
 * 换不出来时原样返回那个绝对路径：一个能用的绝对路径好过一个拼错的相对路径，
 * `absoluteWorktreePath()` 也认得它。
 */
export function workspaceRelativePath(
  path: string,
  workspaceRoot?: string,
): string {
  const target = normalizePath(path);
  const root = workspaceRoot?.trim() ? normalizePath(workspaceRoot) : "";
  if (root === "" || root === ".") return target;
  if (target === root) return ".";
  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : target;
}

/** 这条 checkout 在画布上已有的 Frame；没有就是 `null`。 */
export function existingWorktreeFrame(
  nodes: readonly CanvasNode[],
  path: string,
  workspaceRoot?: string,
): CanvasNode | null {
  return boundFrameForPath(nodes, path, { workspaceRoot });
}

/** 新建 Frame 时写进去的那份绑定。 */
export function worktreeFrameBinding(
  path: string,
  branch: string,
  workspaceRoot?: string,
): FrameBinding {
  const relative = workspaceRelativePath(path, workspaceRoot);
  return {
    worktreePath: relative,
    branch,
    // 发现服务还没跑过时先用路径认这条 checkout，刷新之后由发现结果对齐。
    repositoryId: relative,
    // 右键开出来的 Frame 不带初始化脚本：这条 checkout 早就存在了，此刻替用户
    // 跑一条命令没有任何人要求过。
    initScript: null,
    initScriptState: "none",
    initScriptNodeId: null,
  };
}

/**
 * 在画布上打开绑定这条 worktree 的 Frame，返回它的节点 id。
 *
 * 已经有一个绑着同一条 checkout 的 Frame 就返回那一个，不再建第二个——两个
 * Frame 绑同一个目录之后，「这个终端开在哪」就没有答案了。
 */
export function openWorktreeFrame(
  store: Pick<CanvasStore, "document" | "addNode">,
  input: {
    path: string;
    branch: string;
    workspaceRoot?: string;
    position?: Position;
  },
): string {
  const nodes = store.document?.nodes ?? [];
  const existing = existingWorktreeFrame(
    nodes,
    input.path,
    input.workspaceRoot,
  );
  if (existing) return existing.id;
  return store.addNode("group", {
    title: input.branch,
    size: WORKTREE_FRAME_SIZE,
    ...(input.position ? { position: input.position } : {}),
    data: {
      kind: "group",
      binding: worktreeFrameBinding(
        input.path,
        input.branch,
        input.workspaceRoot,
      ),
    },
  });
}
