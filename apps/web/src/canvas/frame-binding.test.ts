import { describe, expect, it, vi } from "vitest";

/** 往返测试要经过 `project.ts`，它只用 `nodeMeta()` 取默认尺寸。 */
const nodeMetaStub = {
  labelKey: "node.group",
  defaultSize: { width: 520, height: 360 },
  minSize: { width: 160, height: 120 },
  defaultColor: "#0a84ff",
  hasBridgeHandles: false,
};
vi.mock("../nodes/registry", () => ({
  NODE_META: new Proxy({}, { get: () => nodeMetaStub }),
  nodeMeta: () => nodeMetaStub,
}));

import type {
  CanvasNode,
  FrameBinding,
  GitRepositoryRecord,
  GitWorktreeRecord,
} from "@armadra/shared";
import type { TLFrameShape } from "tldraw";

import {
  absoluteWorktreePath,
  armInitScript,
  bindingRepairState,
  boundFrameFor,
  boundFrameForPath,
  boundFrames,
  clearArmedInitScripts,
  consumeArmedInitScript,
  enclosingBoundFrame,
  frameBindingOf,
  inheritedNodeData,
  normalizePath,
  repositoryForBinding,
  samePath,
} from "./frame-binding";
import { nodeToShape } from "./sync/project";
import { shapeToNode } from "./sync/derive";

const BOARD = "019ff7d1-0d12-7421-833d-2c5e8d64ed00";
const FRAME = "019ff7d1-0d12-7421-833d-2c5e8d64ed01";
const CHILD = "019ff7d1-0d12-7421-833d-2c5e8d64ed02";
const GRANDCHILD = "019ff7d1-0d12-7421-833d-2c5e8d64ed03";
const STAMP = "2026-09-05T10:00:00.000Z";
const ROOT = "/Users/dev/project";

function binding(patch: Partial<FrameBinding> = {}): FrameBinding {
  return {
    worktreePath: ".armadra/worktrees/feature",
    branch: "feature/login",
    repositoryId: "repo-1",
    initScript: null,
    initScriptState: "none",
    initScriptNodeId: null,
    ...patch,
  };
}

function node(patch: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: CHILD,
    boardId: BOARD,
    type: "terminal",
    title: "terminal",
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    labels: [],
    note: "",
    data: { kind: "terminal" },
    createdAt: STAMP,
    updatedAt: STAMP,
    ...patch,
  } as CanvasNode;
}

function frame(patch: Partial<CanvasNode> = {}, bound = binding()): CanvasNode {
  return node({
    id: FRAME,
    type: "group",
    title: "feature/login",
    size: { width: 720, height: 560 },
    data: { kind: "group", binding: bound },
    ...patch,
  });
}

function repository(
  patch: Partial<GitRepositoryRecord> = {},
): GitRepositoryRecord {
  return {
    repositoryId: "repo-1",
    repositoryPath: ".armadra/worktrees/feature",
    name: "feature",
    kind: "worktree",
    parentRepositoryId: "repo-0",
    headBranch: "feature/login",
    dirtyCount: 0,
    ...patch,
  };
}

function worktree(patch: Partial<GitWorktreeRecord> = {}): GitWorktreeRecord {
  return {
    path: `${ROOT}/.armadra/worktrees/feature`,
    headOid: "a".repeat(40),
    branch: "feature/login",
    detached: false,
    bare: false,
    isMain: false,
    locked: false,
    lockReason: null,
    prunable: false,
    pruneReason: null,
    accessible: true,
    dirty: false,
    ...patch,
  };
}

describe("路径口径", () => {
  it("规范化去掉结尾斜杠、重复斜杠与开头的 ./", () => {
    expect(normalizePath("a//b/")).toBe("a/b");
    expect(normalizePath("./a/b")).toBe("a/b");
    expect(normalizePath("")).toBe(".");
    expect(normalizePath("/")).toBe(".");
  });

  it("终端要的是绝对路径，没有根时原样退回相对路径", () => {
    expect(absoluteWorktreePath("wt/a", ROOT)).toBe(`${ROOT}/wt/a`);
    expect(absoluteWorktreePath("wt/a")).toBe("wt/a");
    expect(absoluteWorktreePath("/elsewhere/a", ROOT)).toBe("/elsewhere/a");
    expect(absoluteWorktreePath(".", ROOT)).toBe(ROOT);
  });

  it("绝对路径与工作区相对路径能对上", () => {
    expect(samePath(`${ROOT}/wt/a`, "wt/a", ROOT)).toBe(true);
    expect(samePath(`${ROOT}/wt/b`, "wt/a", ROOT)).toBe(false);
    // 没有根时退回后缀比较，宁可多认一个。
    expect(samePath("/anywhere/wt/a", "wt/a")).toBe(true);
    expect(samePath("wt/a", "wt/a")).toBe(true);
  });
});

describe("绑定查找", () => {
  it("只有 group 节点身上才有绑定", () => {
    expect(frameBindingOf(frame())).toEqual(binding());
    expect(frameBindingOf(node())).toBeNull();
    expect(frameBindingOf(null)).toBeNull();
    expect(
      frameBindingOf(
        node({ id: FRAME, type: "group", data: { kind: "group" } }),
      ),
    ).toBeNull();
  });

  it("向上找最近的绑定分组，跨越中间的普通分组", () => {
    const middle = node({
      id: GRANDCHILD,
      type: "group",
      data: { kind: "group" },
      parentId: FRAME,
    });
    const leaf = node({ parentId: GRANDCHILD });
    const nodes = [frame(), middle, leaf];
    expect(boundFrameFor(nodes, leaf.id)?.id).toBe(FRAME);
    // 自己就是绑定分组时返回自己：`addNode` 直接拿 parentId 来问。
    expect(boundFrameFor(nodes, FRAME)?.id).toBe(FRAME);
    expect(boundFrameFor(nodes, "missing")).toBeNull();
    expect(boundFrameFor([node()], CHILD)).toBeNull();
  });

  it("按落点找最里面的那个绑定分组", () => {
    const outer = frame({ position: { x: 0, y: 0 } });
    const inner = frame({
      id: GRANDCHILD,
      parentId: FRAME,
      position: { x: 100, y: 100 },
      size: { width: 200, height: 200 },
    });
    const nodes = [outer, inner];
    expect(enclosingBoundFrame(nodes, { x: 150, y: 150 })?.id).toBe(GRANDCHILD);
    expect(enclosingBoundFrame(nodes, { x: 50, y: 50 })?.id).toBe(FRAME);
    expect(enclosingBoundFrame(nodes, { x: 5_000, y: 5_000 })).toBeNull();
    expect(enclosingBoundFrame(nodes, undefined)).toBeNull();
  });

  it("按路径认出已经绑过的 checkout", () => {
    const nodes = [frame(), node()];
    expect(boundFrames(nodes).map((item) => item.id)).toEqual([FRAME]);
    expect(
      boundFrameForPath(nodes, `${ROOT}/.armadra/worktrees/feature`, {
        workspaceRoot: ROOT,
      })?.id,
    ).toBe(FRAME);
    expect(
      boundFrameForPath(nodes, `${ROOT}/other`, { workspaceRoot: ROOT }),
    ).toBeNull();
  });
});

describe("继承的 data", () => {
  it("终端拿绝对 cwd，编辑器 / 文件树 / diff 拿工作区相对路径", () => {
    const bound = binding();
    expect(
      inheritedNodeData("terminal", bound, { workspaceRoot: ROOT }),
    ).toEqual({ cwd: `${ROOT}/.armadra/worktrees/feature` });
    expect(inheritedNodeData("editor", bound)).toEqual({
      path: ".armadra/worktrees/feature",
    });
    expect(inheritedNodeData("files", bound)).toEqual({
      path: ".armadra/worktrees/feature",
    });
    expect(inheritedNodeData("diff", bound)).toEqual({
      repoPath: ".armadra/worktrees/feature",
    });
  });

  it("没有绑定、或者没有目录这一维的类型不继承", () => {
    expect(inheritedNodeData("terminal", null)).toBeNull();
    expect(inheritedNodeData("sticky", binding())).toBeNull();
    expect(inheritedNodeData("browser", binding())).toBeNull();
  });
});

describe("修复状态", () => {
  it("发现结果或 worktree 列表任一认得就算 ok", () => {
    expect(bindingRepairState(binding(), [repository()], [])).toBe("ok");
    expect(
      bindingRepairState(binding(), [], [worktree()], { workspaceRoot: ROOT }),
    ).toBe("ok");
  });

  it("两份证据都不认得就是 missing", () => {
    expect(
      bindingRepairState(
        binding(),
        [repository({ repositoryPath: "." })],
        [worktree({ path: ROOT })],
        { workspaceRoot: ROOT },
      ),
    ).toBe("missing");
  });

  it("还没读到任何一份证据时不下结论", () => {
    expect(bindingRepairState(binding(), undefined, undefined)).toBe("ok");
    expect(bindingRepairState(null, [], [])).toBe("ok");
  });

  it("不可访问或待清理的 worktree 记录不算数", () => {
    expect(
      bindingRepairState(binding(), [], [worktree({ accessible: false })], {
        workspaceRoot: ROOT,
      }),
    ).toBe("missing");
    expect(
      bindingRepairState(binding(), [], [worktree({ prunable: true })], {
        workspaceRoot: ROOT,
      }),
    ).toBe("missing");
  });

  it("脏文件数从匹配上的那条发现记录读，null 是未知", () => {
    expect(repositoryForBinding(binding(), [repository()])?.dirtyCount).toBe(0);
    expect(
      repositoryForBinding(binding(), [repository({ dirtyCount: null })])
        ?.dirtyCount,
    ).toBeNull();
    expect(repositoryForBinding(binding(), [])).toBeNull();
  });
});

describe("初始化脚本的闸", () => {
  it("只有排过队的那一次能取到，取过就没了", () => {
    clearArmedInitScripts();
    expect(consumeArmedInitScript(FRAME)).toBe(false);
    armInitScript(FRAME);
    expect(consumeArmedInitScript(FRAME)).toBe(true);
    // 重挂、重渲染再问一次都是 false，脚本发不出第二遍。
    expect(consumeArmedInitScript(FRAME)).toBe(false);
  });
});

describe("shape 往返", () => {
  it("绑定跟着 frame 的 meta 走一圈还在", () => {
    const shape = nodeToShape(frame()) as TLFrameShape;
    const back = shapeToNode(shape, BOARD, STAMP);
    expect(frameBindingOf(back)).toEqual(binding());
  });

  it("没绑定的分组往返之后也没有 binding 字段", () => {
    const plain = frame({ data: { kind: "group" } });
    const back = shapeToNode(nodeToShape(plain) as TLFrameShape, BOARD, STAMP);
    expect(back.data).toEqual({ kind: "group" });
  });
});
