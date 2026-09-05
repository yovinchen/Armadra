import type {
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  FrameBinding,
  GitRepositoryRecord,
  GitWorktreeRecord,
  Position,
} from "@armadra/shared";

/**
 * Frame ↔ worktree 绑定的纯函数层（roadmap §3.4 G03）。
 *
 * 这个模块**不引任何运行期依赖**（只引类型）：`canvas-store` 要在 `addNode`
 * 里调它，而 `store → canvas/geometry → store` 已经是一个环，再多一条就会
 * 在模块顶层求值时拿到未初始化的绑定。所以尺寸/坐标在这里自己算。
 *
 * 路径口径（两处不同，混用过一次就是「终端开在错的目录」的根因）：
 *  - `binding.worktreePath` 与仓库发现的 `repositoryPath` 都是**工作区相对**；
 *  - `git worktree list` 回来的 `GitWorktreeRecord.path` 是 **git 给的绝对路径**；
 *  - 终端的 `cwd` 会被 Runtime 原样交给 `command.cwd()`（terminal/direct.rs），
 *    相对路径会落到 Runtime 进程自己的工作目录上，所以必须是绝对路径。
 */

/* --------------------------------- 路径 ----------------------------------- */

/** 比较用的规范化：`\` → `/`、合并重复斜杠、去掉结尾斜杠与开头的 `./`。 */
export function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const trimmed = slashed.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === ".") return ".";
  return trimmed.replace(/^\.\//, "");
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * 工作区相对路径 → 绝对路径。`workspaceRoot` 缺席时原样返回：调用方拿到的
 * 仍是一个能用的相对路径，好过拼出一个假的绝对路径。
 */
export function absoluteWorktreePath(
  worktreePath: string,
  workspaceRoot?: string,
): string {
  const relative = normalizePath(worktreePath);
  if (isAbsolute(relative)) return relative;
  const root = workspaceRoot?.trim();
  if (!root) return relative;
  const base = normalizePath(root);
  if (relative === ".") return base;
  return `${base}/${relative}`;
}

/**
 * `candidate`（可能是绝对路径）指的是不是工作区相对的 `relative` 那个 checkout。
 *
 * 拿不到 `workspaceRoot` 时退回后缀比较：worktree 列表里的绝对路径以
 * `/<相对路径>` 结尾就算命中。宁可多认一个，也好过把一个健在的 worktree
 * 判成 missing 后弹出修复提示。
 */
export function samePath(
  candidate: string,
  relative: string,
  workspaceRoot?: string,
): boolean {
  const left = normalizePath(candidate);
  const right = normalizePath(relative);
  if (left === right) return true;
  if (workspaceRoot?.trim()) {
    return left === absoluteWorktreePath(right, workspaceRoot);
  }
  return right !== "." && left.endsWith(`/${right}`);
}

/* -------------------------------- 绑定查找 -------------------------------- */

/** 节点身上的绑定；不是分组、没绑定都是 `null`。 */
export function frameBindingOf(
  node: CanvasNode | null | undefined,
): FrameBinding | null {
  if (!node || node.type !== "group") return null;
  const data = node.data as Extract<CanvasNodeData, { kind: "group" }>;
  return data.binding ?? null;
}

/** 已绑定的分组节点。 */
export function boundFrames(nodes: readonly CanvasNode[]): CanvasNode[] {
  return nodes.filter((node) => frameBindingOf(node) !== null);
}

/**
 * 从 `nodeId` 出发向上找最近的、已绑定的分组——**包含它自己**，这样
 * `addNode` 可以直接拿 `options.parentId` 来问（新节点还没进文档）。
 */
export function boundFrameFor(
  nodes: readonly CanvasNode[],
  nodeId: string | null | undefined,
): CanvasNode | null {
  let current = nodes.find((node) => node.id === nodeId);
  // 文档理论上不会有环，但坏数据不该让画布死循环。
  for (let depth = 0; current && depth <= 16; depth += 1) {
    if (frameBindingOf(current)) return current;
    const parentId: string | undefined = current.parentId;
    if (!parentId) return null;
    current = nodes.find((node) => node.id === parentId);
  }
  return null;
}

/** 组员坐标是相对父组的；这里换算成画布绝对坐标（本地实现，见文件头注释）。 */
function absolutePositionOf(
  nodes: readonly CanvasNode[],
  node: CanvasNode,
  depth = 0,
): Position {
  if (!node.parentId || depth > 8) return node.position;
  const parent = nodes.find((candidate) => candidate.id === node.parentId);
  if (!parent) return node.position;
  const base = absolutePositionOf(nodes, parent, depth + 1);
  return { x: base.x + node.position.x, y: base.y + node.position.y };
}

/**
 * 落点落在哪个已绑定分组里（右键新建走的是 `position`，没有 `parentId`）。
 *
 * 嵌套时取面积最小的那个，也就是最靠内的一层。没有 `size` 的分组直接跳过：
 * 尺寸的唯一真相在 `nodes/registry`，为了不引它进来这里不做兜底。
 */
export function enclosingBoundFrame(
  nodes: readonly CanvasNode[],
  position: Position | undefined,
): CanvasNode | null {
  if (!position) return null;
  let best: CanvasNode | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (!frameBindingOf(node) || !node.size) continue;
    const origin = absolutePositionOf(nodes, node);
    const { width, height } = node.size;
    if (
      position.x < origin.x ||
      position.y < origin.y ||
      position.x > origin.x + width ||
      position.y > origin.y + height
    )
      continue;
    const area = width * height;
    if (area < bestArea) {
      best = node;
      bestArea = area;
    }
  }
  return best;
}

/* ------------------------------- 继承的 data ------------------------------ */

/**
 * 在已绑定分组里新建的节点应当继承的 data 补丁。
 *
 * 终端拿**绝对**路径（`cwd` 直接就是子进程的工作目录），编辑器 / 文件树 /
 * diff 拿**工作区相对**路径（`defaultNodeData` 给的 root、拖拽导入写进去的
 * `path` 都是相对的，Runtime 侧统一按工作区根解析）。
 *
 * 其余类型没有「目录」这一维，返回 `null` 表示不继承。
 */
export function inheritedNodeData(
  type: CanvasNodeType,
  binding: FrameBinding | null | undefined,
  context: { workspaceRoot?: string } = {},
): Partial<CanvasNodeData> | null {
  if (!binding) return null;
  const relative = normalizePath(binding.worktreePath);
  switch (type) {
    case "terminal":
      return { cwd: absoluteWorktreePath(relative, context.workspaceRoot) };
    case "editor":
    case "files":
      return { path: relative };
    case "diff":
      return { repoPath: relative };
    default:
      return null;
  }
}

/* -------------------------------- 修复状态 -------------------------------- */

export type BindingRepairState = "ok" | "missing";

/**
 * 绑定指向的 checkout 还在不在。
 *
 * 两份证据任意一份认得这条路径就算 `ok`：仓库发现列表（工作区相对）和
 * `git worktree list`（绝对）。两份都还没加载完时也当 `ok` —— 加载中不是
 * 「不存在」，不该在读盘途中给用户弹修复提示。
 */
export function bindingRepairState(
  binding: FrameBinding | null | undefined,
  repositories: readonly GitRepositoryRecord[] | null | undefined,
  worktrees: readonly GitWorktreeRecord[] | null | undefined,
  context: { workspaceRoot?: string } = {},
): BindingRepairState {
  if (!binding) return "ok";
  if (!repositories && !worktrees) return "ok";
  const relative = normalizePath(binding.worktreePath);
  const inRepositories = (repositories ?? []).some((record) =>
    samePath(record.repositoryPath, relative, context.workspaceRoot),
  );
  if (inRepositories) return "ok";
  const inWorktrees = (worktrees ?? []).some(
    (record) =>
      record.accessible &&
      !record.prunable &&
      samePath(record.path, relative, context.workspaceRoot),
  );
  return inWorktrees ? "ok" : "missing";
}

/** 绑定到某个 checkout 的分组（worktree 列表里认「这条已经有 Frame 了」）。 */
export function boundFrameForPath(
  nodes: readonly CanvasNode[],
  path: string,
  context: { workspaceRoot?: string } = {},
): CanvasNode | null {
  return (
    nodes.find((node) => {
      const binding = frameBindingOf(node);
      return (
        binding !== null &&
        samePath(path, binding.worktreePath, context.workspaceRoot)
      );
    }) ?? null
  );
}

/* ------------------------------ 初始化脚本的闸 ---------------------------- */

/**
 * 「这个 Frame 的初始化脚本可以发一次」的闸，只活在本次运行里。
 *
 * 一次性的保证靠两道锁：`initScriptState` 只有 `pending` 会发（发之前先落
 * 盘成 `running`，重载看到的就不是 `pending` 了），以及这个模块级集合——
 * 它不落盘，所以刷新、重挂、重渲染都不可能再把同一个脚本发第二次。
 *
 * 代价是：创建之后、终端起来之前就刷新页面，脚本不会自己补发，徽章上停在
 * 「待运行」。这是有意的——悄悄替用户跑一条命令比不跑更糟。
 */
const armedInitScripts = new Set<string>();

export function armInitScript(frameNodeId: string): void {
  armedInitScripts.add(frameNodeId);
}

/** 取闸：只有第一次调用返回 true。 */
export function consumeArmedInitScript(frameNodeId: string): boolean {
  return armedInitScripts.delete(frameNodeId);
}

/** 仅测试用。 */
export function clearArmedInitScripts(): void {
  armedInitScripts.clear();
}

/** 绑定对应的仓库记录（脏文件数就从这里读）。 */
export function repositoryForBinding(
  binding: FrameBinding | null | undefined,
  repositories: readonly GitRepositoryRecord[] | null | undefined,
  context: { workspaceRoot?: string } = {},
): GitRepositoryRecord | null {
  if (!binding) return null;
  const relative = normalizePath(binding.worktreePath);
  return (
    (repositories ?? []).find((record) =>
      samePath(record.repositoryPath, relative, context.workspaceRoot),
    ) ?? null
  );
}
