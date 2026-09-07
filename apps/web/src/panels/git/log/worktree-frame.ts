import type {
  CanvasNode,
  FrameBinding,
  GitBranchRecord,
  Position,
} from "@armadra/shared";

import {
  armInitScript,
  boundFrameForPath,
  normalizePath,
  samePath,
} from "../../../canvas/frame-binding";
import type { CanvasStore } from "../../../store/canvas/types";
import { localBranch } from "../worktree";

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

/** 初始化终端在 Frame 里的落点（相对 Frame 左上角，让开徽章）。 */
export const INIT_TERMINAL_POSITION = { x: 24, y: 72 };

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

/**
 * 新建 Frame 时写进去的那份绑定。
 *
 * `initScript` 缺席时不排队：右键在一条**早就存在**的 checkout 上开 Frame，
 * 此刻替用户跑一条命令没有任何人要求过。只有「新建 worktree」那条路径才会把
 * 用户刚填的脚本传进来。
 */
export function worktreeFrameBinding(
  path: string,
  branch: string,
  workspaceRoot?: string,
  initScript?: string | null,
): FrameBinding {
  const relative = workspaceRelativePath(path, workspaceRoot);
  const script = initScript?.trim() ? initScript.trim() : null;
  return {
    worktreePath: relative,
    branch,
    // 发现服务还没跑过时先用路径认这条 checkout，刷新之后由发现结果对齐。
    repositoryId: relative,
    initScript: script,
    initScriptState: script ? "pending" : "none",
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

/* ------------------------------ 新建 worktree ----------------------------- */

/**
 * 「新建 Worktree…」对话框收上来的那几个框。
 *
 * 表单是数据，画表单才是组件的事：能不能提交、要不要建 Frame、脚本要不要跑，
 * 三件事都只由下面几个纯函数回答，所以能被单测钉住。
 */
export interface WorktreeFormValue {
  /** 工作区内的相对路径；`FrameBinding.worktreePath` 记的就是这一份。 */
  path: string;
  branch: string;
  createBranch: boolean;
  startPoint: string;
  createFrame: boolean;
  initScript: string;
}

export const EMPTY_WORKTREE_FORM: WorktreeFormValue = {
  path: "",
  branch: "",
  createBranch: true,
  startPoint: "",
  createFrame: false,
  initScript: "",
};

/** 这一次创建附带的画布意图；worktree 真的出现在快照里之后才兑现。 */
export interface WorktreeFrameIntent {
  path: string;
  branch: string;
  /** 空串 = 不跑初始化脚本，也就不建那个终端。 */
  script: string;
}

/**
 * 表单能不能提交。
 *
 * 检出一条**已有**分支时必须认得它：`createWorktreeAction()` 要拿这一次读到
 * 的 OID 当期望值，认不出来就没有 OID 可带，Runtime 会去动一条谁都没看过的
 * 分支。
 */
export function worktreeFormReady(
  value: WorktreeFormValue,
  branches: readonly GitBranchRecord[],
): boolean {
  if (!value.path.trim() || !value.branch.trim()) return false;
  return value.createBranch || localBranch(branches, value.branch) !== null;
}

/** 勾了「同时创建 Frame」才有意图；没勾就是 `null`。 */
export function worktreeFrameIntent(
  value: WorktreeFormValue,
): WorktreeFrameIntent | null {
  if (!value.createFrame) return null;
  return {
    path: value.path.trim(),
    branch: value.branch.trim(),
    script: value.initScript.trim(),
  };
}

/**
 * 这一次创建兑现了没有。
 *
 * 凭据是 **`git worktree list` 自己**——日志页的 `git-refs` 快照里每个仓库都
 * 带一份，写成功之后那条查询已经被失效重读，所以不必再单问一次
 * `gitGateway.worktrees()`：多一次请求换不来更新的事实，只会多出一份可能和
 * 分支树自相矛盾的答案。
 *
 * 路径之外还要求分支对得上：路径命中只说明「那个位置有一个检出」，而这一次
 * 创建要的是「那个位置检出着我刚要的这条分支」。少了这一条，一条同路径的旧
 * 检出就能把一次失败的创建冒充成功。
 *
 * 代价是 `git-refs` 不交出 `accessible`：目录被外部删掉、条目还挂在
 * `worktree list` 里的那一瞬间会被认成兑现。这是可接受的——那种状态下画布上
 * 的 Frame 会由 `bindingRepairState()` 标成 missing，而不是无声地指错地方。
 */
export function worktreeIntentFulfilled(
  worktrees: readonly { path: string; branch: string | null }[],
  intent: WorktreeFrameIntent,
  workspaceRoot?: string,
): boolean {
  return worktrees.some(
    (record) =>
      record.branch === intent.branch &&
      samePath(record.path, intent.path, workspaceRoot),
  );
}

/**
 * 兑现意图：建 Frame，需要时建初始化终端并开闸。返回 Frame 的节点 id。
 *
 * 画布一律经 `canvas-store` 的动作改，这里不碰 document。已经有 Frame 绑着
 * 这条 checkout 时返回 `null`，一个不建——两个 Frame 绑同一个目录之后，
 * 「这个终端开在哪」就没有答案了。
 */
export function fulfilWorktreeIntent(
  store: Pick<CanvasStore, "document" | "addNode" | "updateNodeData">,
  intent: WorktreeFrameIntent,
  options: {
    workspaceRoot?: string;
    /** 初始化终端的标题，由调用方经 `t()` 取。 */
    terminalTitle: string;
    position?: Position;
  },
): string | null {
  const nodes = store.document?.nodes ?? [];
  if (existingWorktreeFrame(nodes, intent.path, options.workspaceRoot)) {
    return null;
  }
  const script = intent.script.trim();
  const binding = worktreeFrameBinding(
    intent.path,
    intent.branch,
    options.workspaceRoot,
    script,
  );
  const frameId = store.addNode("group", {
    title: intent.branch,
    size: WORKTREE_FRAME_SIZE,
    ...(options.position ? { position: options.position } : {}),
    data: { kind: "group", binding },
  });
  if (!frameId) return null;
  if (!script) return frameId;
  // cwd 不用在这里拼：`addNode` 认得父 Frame 上的绑定，会把 worktree 目录
  // 继承下来（`canvas/frame-binding.ts`）。
  const terminalId = store.addNode("terminal", {
    parentId: frameId,
    position: INIT_TERMINAL_POSITION,
    title: options.terminalTitle,
  });
  if (!terminalId) return frameId;
  // 写回的是刚构造的那一份，而不是从 store 再读一次：`addNode` 原样存下
  // `options.data`，再读一次只多一次读到旧快照的机会。
  store.updateNodeData(frameId, {
    binding: { ...binding, initScriptNodeId: terminalId },
  });
  // 开闸：脚本只有被这一次创建排过队才会被发出去，且只发一次。
  armInitScript(frameId);
  return frameId;
}
