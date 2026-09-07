import { describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "@armadra/shared";

import {
  existingWorktreeFrame,
  openWorktreeFrame,
  workspaceRelativePath,
  worktreeFrameBinding,
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
