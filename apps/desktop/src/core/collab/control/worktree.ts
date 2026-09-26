import { isAbsolute, join, relative } from "node:path";

import type { BoardDocument, CanvasNode } from "../../canvas/document-types";
import { invalidate } from "../../git/discovery";
import { gitService } from "../../git/index";
import { startOperation } from "../../git/repository/queue";
import { RepositoryService } from "../../git/repository/service";
import { isTerminal } from "../../git/repository/types";
import { worktreeRecords } from "../../git/repository/worktrees";
import { canonicalize, contains } from "../../workspaces/roots";
import { getWorkspace } from "../../workspaces/table";
import type { Caller } from "../nodes";
import { Refusal } from "../refusals";
import type { CollabContext } from "../service";
import { newNode, placement } from "./board";

/**
 * `team --member "…|worktree=<名字或路径>"` 与 `open-agent --worktree`：让一个
 * 成员在自己的 worktree 里干活（G03 的 Frame 绑定，Git 工具窗口设计 §5）。
 *
 * 与页面上「新建 worktree 并建 Frame」是同一个结果：检出不存在就建（同一条
 * Git 写队列），画布上没有绑着它的 Frame 就建一个，成员放进 Frame 里，终端的
 * `cwd` 是 worktree 的绝对路径——与 `addNode` 在已绑定的 Frame 里建终端时
 * 继承的那一份相同。已经有 Frame 绑着这条检出就放进那一个，不建第二个：两个
 * Frame 绑同一个目录，「终端开在哪」就没有答案了。
 *
 * 写法：
 *   * 名字（不含 `/`）：先找分支名或目录名是它的现有 worktree；没有就在
 *     `.worktrees/<名字>` 新建，分支也叫这个名字，从当前 HEAD 起。
 *   * 路径（工作区内的相对路径，或落在工作区里的绝对路径）：那里已是一条
 *     worktree 就用它；没有就在那里新建，分支名取目录名。
 */

/** 新建检出时名字对应的目录。 */
export const WORKTREE_DIR = ".worktrees";

/** 与页面上新建绑定 Frame 的尺寸一致（`worktree-frame.ts`）。 */
const FRAME_SIZE = { width: 1040, height: 720 };
/** Frame 里第一个成员的落点（相对 Frame 左上角，让开徽章）。 */
const INSIDE = { x: 24, y: 72 };
const STEP = 36;

const WAIT_MS = 60_000;

/** 解析好的一条 worktree：画布上要的全部。 */
export interface WorktreeTarget {
  /** 工作区相对路径——`FrameBinding.worktreePath` 记的就是这一份。 */
  readonly relative: string;
  /** 终端的 `cwd`。 */
  readonly absolute: string;
  readonly branch: string;
  /** 这一次才建出来的检出。 */
  readonly created: boolean;
}

let fallback: RepositoryService | undefined;

function service(): RepositoryService {
  // 装配好的 core 一定有那一个；只有不装 Git 域的用例才走到后面。
  return gitService() ?? (fallback ??= new RepositoryService());
}

/** `worktree=` 的值：名字或路径，控制字符与 `..` 一律不收。 */
export function checkWorktreeSpec(raw: string, flag: string): string {
  const value = raw.trim();
  if (
    value === "" ||
    value.length > 1_024 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.split(/[/\\]/).includes("..")
  ) {
    throw Refusal.badRequest(
      `${flag} 的 worktree 是名字或工作区内的路径（不含 ..）。`,
    );
  }
  return value;
}

function slashed(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * 找到或建出一条 worktree。在建任何节点之前调：Git 拒绝（分支已存在、目录
 * 被占、不是仓库）就整个动词拒绝，不留下半个团。
 */
export async function ensureWorktree(
  context: CollabContext,
  caller: Caller,
  spec: string,
): Promise<WorktreeTarget> {
  const workspace = getWorkspace(context.database, caller.node.workspaceId);
  if (workspace.executionHostId !== undefined) {
    throw Refusal.badRequest(
      "这个工作区在远端执行主机上，--worktree 目前只支持本机工作区。",
    );
  }
  if (!workspace.permissions.write || !workspace.permissions.execute) {
    throw Refusal.forbidden(
      "这个工作区没有写入与执行权限，不能替成员建 worktree。",
    );
  }
  let root: string;
  try {
    root = canonicalize(workspace.rootPath);
  } catch {
    throw Refusal.badRequest("工作区根目录不存在。");
  }
  const git = service().withExecution(true);
  let repository;
  try {
    repository = await git.context(root, ".");
  } catch {
    throw Refusal.badRequest(
      "工作区根目录不是 Git 仓库，没法给成员建 worktree。",
    );
  }
  const records = (await worktreeRecords(git, repository)).filter(
    (record) => !record.bare && record.accessible,
  );
  const named = !/[/\\]/.test(spec);
  const requested = named
    ? join(root, WORKTREE_DIR, spec)
    : isAbsolute(spec)
      ? spec
      : join(root, spec);
  const within = (path: string): string => slashed(relative(root, path)) || ".";
  const existing = records.find((record) => {
    let canonical: string;
    try {
      canonical = canonicalize(record.path);
    } catch {
      return false;
    }
    // 名字：分支名或目录名就是它（主检出不算——成员要的是自己的一份）。
    if (named)
      return (
        !record.isMain &&
        (record.branch === spec || slashed(canonical).split("/").pop() === spec)
      );
    try {
      return canonical === canonicalize(requested);
    } catch {
      return false;
    }
  });
  if (existing !== undefined) {
    const absolute = canonicalize(existing.path);
    if (!contains(root, absolute))
      throw Refusal.forbidden(`${spec} 这条 worktree 在工作区之外。`);
    return {
      relative: within(absolute),
      absolute,
      branch: existing.branch ?? within(absolute),
      created: false,
    };
  }
  if (!contains(root, requested))
    throw Refusal.badRequest(`${spec} 不在工作区里。`);
  const target = within(requested);
  const branch = named ? spec : (target.split("/").pop() ?? target);
  const head = await git.head(repository.repository);
  let snapshot;
  try {
    snapshot = await startOperation(
      git,
      root,
      ".",
      {
        kind: "createWorktree",
        path: target,
        branch,
        createBranch: true,
        expectedOid: null,
        startPoint: null,
      },
      head,
    );
  } catch (error) {
    throw Refusal.badRequest(
      `建 worktree ${target}（分支 ${branch}）失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const started = Date.now();
  for (;;) {
    const state = git.entry(snapshot.id)?.snapshot;
    if (state !== undefined && isTerminal(state.state)) {
      if (state.state !== "succeeded")
        throw Refusal.badRequest(
          `建 worktree ${target}（分支 ${branch}）没有成功：${state.message ?? state.state}`,
        );
      break;
    }
    if (Date.now() - started > WAIT_MS)
      throw Refusal.badRequest(`建 worktree ${target} 超时。`);
    await new Promise((done) => setTimeout(done, 50));
  }
  invalidate(caller.node.workspaceId);
  return {
    relative: target,
    absolute: canonicalize(requested),
    branch,
    created: true,
  };
}

function bindingOf(node: CanvasNode): { worktreePath?: unknown } | undefined {
  if (node.type !== "group") return undefined;
  const data = node.data as { binding?: { worktreePath?: unknown } } | null;
  return data?.binding ?? undefined;
}

/**
 * 画布上绑着这条检出的 Frame；没有就建一个（不进文档，由调用方一起存）。
 * 返回 Frame 以及它此刻已有几个子节点——新成员按这个数错开落点。
 */
export function frameFor(
  document: BoardDocument,
  caller: Caller,
  target: WorktreeTarget,
): { frame: CanvasNode; created: boolean; children: number } {
  const bound = document.nodes.find((node) => {
    const path = bindingOf(node)?.worktreePath;
    return (
      typeof path === "string" &&
      slashed(path).replace(/\/+$/, "").replace(/^\.\//, "") === target.relative
    );
  });
  if (bound !== undefined) {
    return {
      frame: bound,
      created: false,
      children: document.nodes.filter((node) => node.parentId === bound.id)
        .length,
    };
  }
  const frame: CanvasNode = {
    ...newNode(
      document.board.id,
      "group",
      target.branch,
      placement(document, caller.node.id),
      {
        kind: "group",
        binding: {
          worktreePath: target.relative,
          branch: target.branch,
          // 发现服务还没跑过时先用路径认这条检出，刷新之后由发现结果对齐
          // （与页面上的 `worktreeFrameBinding` 同一个口径）。
          repositoryId: target.relative,
          initScript: null,
          initScriptState: "none",
          initScriptNodeId: null,
        },
      },
    ),
    size: FRAME_SIZE,
  };
  return { frame, created: true, children: 0 };
}

/** 第 `index` 个放进这个 Frame 的成员，相对 Frame 左上角的落点。 */
export function insideFrame(index: number): { x: number; y: number } {
  return { x: INSIDE.x + index * STEP, y: INSIDE.y + index * STEP };
}
