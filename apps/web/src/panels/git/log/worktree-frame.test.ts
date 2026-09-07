import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode, GitBranchRecord } from "@armadra/shared";

import {
  clearArmedInitScripts,
  consumeArmedInitScript,
} from "../../../canvas/frame-binding";
import {
  EMPTY_WORKTREE_FORM,
  existingWorktreeFrame,
  fulfilWorktreeIntent,
  openWorktreeFrame,
  workspaceRelativePath,
  worktreeFormReady,
  worktreeFrameBinding,
  worktreeFrameIntent,
  worktreeIntentFulfilled,
} from "./worktree-frame";

/**
 * 分支树交出的是绝对路径，绑定记的是工作区相对路径。这个换算错一次，Frame 就
 * 指向一个不存在的目录，而画布上看不出来。
 */

function frame(worktreePath: string): CanvasNode {
  return {
    id: "frame-1",
    boardId: "board",
    type: "group",
    title: "feature",
    color: "",
    position: { x: 0, y: 0 },
    size: { width: 10, height: 10 },
    labels: [],
    note: "",
    data: {
      kind: "group",
      binding: {
        worktreePath,
        branch: "feature",
        repositoryId: worktreePath,
        initScript: null,
        initScriptState: "none",
        initScriptNodeId: null,
      },
    },
    createdAt: "",
    updatedAt: "",
  } as unknown as CanvasNode;
}

describe("路径换算", () => {
  it("工作区里的绝对路径换成相对路径", () => {
    expect(workspaceRelativePath("/w/checkouts/a", "/w")).toBe("checkouts/a");
    expect(workspaceRelativePath("/w", "/w")).toBe(".");
  });

  it("工作区外的路径原样保留，没有工作区根时也原样保留", () => {
    expect(workspaceRelativePath("/other/a", "/w")).toBe("/other/a");
    expect(workspaceRelativePath("/w/a")).toBe("/w/a");
  });

  it("绑定记的是换算之后那一份", () => {
    expect(
      worktreeFrameBinding("/w/checkouts/a", "feature", "/w"),
    ).toMatchObject({
      worktreePath: "checkouts/a",
      branch: "feature",
      initScriptState: "none",
    });
  });
});

describe("打开 Frame", () => {
  it("已经绑着这条 checkout 的 Frame 不再建第二个", () => {
    const nodes = [frame("checkouts/a")];
    expect(existingWorktreeFrame(nodes, "/w/checkouts/a", "/w")?.id).toBe(
      "frame-1",
    );
    const addNode = vi.fn(() => "new");
    const id = openWorktreeFrame(
      { document: { nodes } as never, addNode },
      { path: "/w/checkouts/a", branch: "feature", workspaceRoot: "/w" },
    );
    expect(id).toBe("frame-1");
    expect(addNode).not.toHaveBeenCalled();
  });

  it("还没有 Frame 时经 addNode 建一个带绑定的分组", () => {
    const addNode = vi.fn(() => "new");
    const id = openWorktreeFrame(
      { document: { nodes: [] } as never, addNode },
      { path: "/w/checkouts/b", branch: "feat/b", workspaceRoot: "/w" },
    );
    expect(id).toBe("new");
    expect(addNode).toHaveBeenCalledWith(
      "group",
      expect.objectContaining({
        title: "feat/b",
        data: expect.objectContaining({
          kind: "group",
          binding: expect.objectContaining({ worktreePath: "checkouts/b" }),
        }),
      }),
    );
  });
});

/* ------------------------------ 新建 worktree ----------------------------- */

function branchRecord(name: string): GitBranchRecord {
  return {
    name,
    fullRef: `refs/heads/${name}`,
    oid: "c".repeat(40),
    remote: false,
    current: false,
    upstream: null,
    ahead: null,
    behind: null,
    upstreamMissing: false,
    symbolicTarget: null,
  };
}

describe("新建表单", () => {
  it("新建分支只要路径和名字", () => {
    expect(
      worktreeFormReady(
        { ...EMPTY_WORKTREE_FORM, path: " checkouts/a ", branch: "feat/x" },
        [],
      ),
    ).toBe(true);
    expect(
      worktreeFormReady({ ...EMPTY_WORKTREE_FORM, branch: "feat/x" }, []),
    ).toBe(false);
  });

  it("检出已有分支时必须认得那条分支（否则没有 OID 可带）", () => {
    const value = {
      ...EMPTY_WORKTREE_FORM,
      path: "checkouts/a",
      branch: "main",
      createBranch: false,
    };
    expect(worktreeFormReady(value, [])).toBe(false);
    expect(worktreeFormReady(value, [branchRecord("main")])).toBe(true);
  });

  it("没勾「同时创建 Frame」就没有意图，勾了的意图去掉两头空白", () => {
    const value = {
      ...EMPTY_WORKTREE_FORM,
      path: " checkouts/a ",
      branch: " feat/x ",
      initScript: " pnpm i ",
    };
    expect(worktreeFrameIntent(value)).toBeNull();
    expect(worktreeFrameIntent({ ...value, createFrame: true })).toEqual({
      path: "checkouts/a",
      branch: "feat/x",
      script: "pnpm i",
    });
  });
});

describe("意图的兑现条件", () => {
  const intent = { path: "checkouts/a", branch: "feat/x", script: "" };

  it("worktree list 里出现这条路径、且检出的是这条分支才算兑现", () => {
    expect(worktreeIntentFulfilled([], intent, "/w")).toBe(false);
    expect(
      worktreeIntentFulfilled(
        [{ path: "/w/checkouts/a", branch: "feat/x" }],
        intent,
        "/w",
      ),
    ).toBe(true);
  });

  it("同一个位置上的另一条分支不算：那不是这一次创建的结果", () => {
    expect(
      worktreeIntentFulfilled(
        [{ path: "/w/checkouts/a", branch: "old" }],
        intent,
        "/w",
      ),
    ).toBe(false);
    expect(
      worktreeIntentFulfilled(
        [{ path: "/w/checkouts/b", branch: "feat/x" }],
        intent,
        "/w",
      ),
    ).toBe(false);
  });

  it("游离的检出没有分支，也就永远兑现不了一个带分支的意图", () => {
    expect(
      worktreeIntentFulfilled(
        [{ path: "/w/checkouts/a", branch: null }],
        intent,
        "/w",
      ),
    ).toBe(false);
  });
});

describe("兑现意图", () => {
  beforeEach(() => clearArmedInitScripts());

  function store(nodes: CanvasNode[] = []) {
    const ids = ["frame-new", "terminal-new"];
    return {
      document: { nodes } as never,
      addNode: vi.fn(() => ids.shift() ?? ""),
      updateNodeData: vi.fn(),
    };
  }

  it("填了脚本就建终端、回写 initScriptNodeId 并开闸", () => {
    const target = store();
    const id = fulfilWorktreeIntent(
      target,
      { path: "checkouts/a", branch: "feat/x", script: "pnpm i" },
      { workspaceRoot: "/w", terminalTitle: "init" },
    );
    expect(id).toBe("frame-new");
    expect(target.addNode).toHaveBeenNthCalledWith(
      1,
      "group",
      expect.objectContaining({
        title: "feat/x",
        data: {
          kind: "group",
          binding: expect.objectContaining({
            worktreePath: "checkouts/a",
            initScript: "pnpm i",
            initScriptState: "pending",
            initScriptNodeId: null,
          }),
        },
      }),
    );
    expect(target.addNode).toHaveBeenNthCalledWith(
      2,
      "terminal",
      expect.objectContaining({ parentId: "frame-new", title: "init" }),
    );
    expect(target.updateNodeData).toHaveBeenCalledWith("frame-new", {
      binding: expect.objectContaining({ initScriptNodeId: "terminal-new" }),
    });
    expect(consumeArmedInitScript("frame-new")).toBe(true);
  });

  it("没填脚本就只有一个 Frame，闸也不开", () => {
    const target = store();
    expect(
      fulfilWorktreeIntent(
        target,
        { path: "checkouts/a", branch: "feat/x", script: "" },
        { workspaceRoot: "/w", terminalTitle: "init" },
      ),
    ).toBe("frame-new");
    expect(target.addNode).toHaveBeenCalledTimes(1);
    expect(target.updateNodeData).not.toHaveBeenCalled();
    expect(consumeArmedInitScript("frame-new")).toBe(false);
  });

  it("这条 checkout 已经有 Frame 了就一个都不建", () => {
    const target = store([frame("checkouts/a")]);
    expect(
      fulfilWorktreeIntent(
        target,
        { path: "checkouts/a", branch: "feat/x", script: "pnpm i" },
        { workspaceRoot: "/w", terminalTitle: "init" },
      ),
    ).toBeNull();
    expect(target.addNode).not.toHaveBeenCalled();
  });
});
