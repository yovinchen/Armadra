import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, fixture } from "../workspaces/fixture";
import { createWorkspace } from "../workspaces/table";
import { type Board, createBoard, listBoards } from "./boards";
import type { CanvasNode } from "./document-types";
import { loadBoard, saveBoard } from "./documents";
import {
  handleForNode,
  handlesFor,
  nodeNamed,
  normalizeHandle,
} from "./handles";
import { stickyNode } from "./nodes.fixture";

/**
 * Agent 的名字（`docs/design/agent-delivery.md` §2）。
 *
 * 这一套用例守的是表，不是动词：`node_handles` 是唯一来源，而 `data.handle`
 * 是它的渲染副本。最后一条是那条风险的守卫——两者只有一个写入点，所以不可能
 * 各自漂移。
 */
describe("node names", () => {
  let core: Fixture;
  let workspaceId: string;
  let board: Board;

  beforeEach(() => {
    core = fixture([]);
    workspaceId = createWorkspace(core.database, {
      name: "fixture",
      rootPath: core.directory,
    }).id;
    const first = listBoards(core.database, workspaceId)[0];
    if (first === undefined) throw new Error("the default board is missing");
    board = first;
  });
  afterEach(() => {
    core.close();
  });

  /** Saves `nodes` onto `target`, rebasing on whatever revision it is at. */
  function save(nodes: readonly CanvasNode[], target: Board = board): void {
    const current = loadBoard(core.database, workspaceId, target.id);
    saveBoard(core.database, workspaceId, target.id, {
      expectedUpdatedAt: current.board.updatedAt,
      nodes: [...nodes],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
  }

  function named(handle: string | undefined, target = board): CanvasNode {
    const node = stickyNode(target.id);
    return handle === undefined
      ? node
      : { ...node, data: { ...(node.data as object), handle } };
  }

  it("folds case and refuses anything that would need quoting", () => {
    expect(normalizeHandle("Review")).toBe("review");
    expect(normalizeHandle("  codex-1 ")).toBe("codex-1");
    expect(normalizeHandle("has space")).toBeUndefined();
    expect(normalizeHandle("-leading")).toBeUndefined();
    expect(normalizeHandle("x".repeat(25))).toBeUndefined();
  });

  it("registers a name from the document and reads it back from the table", () => {
    const alice = named("reviewer");
    save([alice]);
    expect(handleForNode(core.database, alice.id)).toBe("reviewer");
    expect(handlesFor(core.database, [alice.id]).get(alice.id)).toBe(
      "reviewer",
    );
    expect(nodeNamed(core.database, board.id, "reviewer")?.id).toBe(alice.id);
  });

  it("refuses two nodes claiming the same name, and says whose it is", () => {
    const alice = { ...named("reviewer"), title: "复查 src/api" };
    save([alice]);
    const bob = named("Reviewer");
    expect(() => save([alice, bob])).toThrowError(/复查 src\/api/);
    // 拒绝是整次保存的拒绝：事务回滚，bob 没有进库。
    expect(handleForNode(core.database, bob.id)).toBeUndefined();
    expect(handleForNode(core.database, alice.id)).toBe("reviewer");
  });

  /**
   * 「并发改名」在这套装配里就是两次基于同一版本的保存：第二次撞上板文档的
   * CAS，名字也不会被它写进去。约束因此从来不是某个动词自己的一次读-判-写。
   */
  it("holds under two renames racing for the same name", () => {
    const alice = named(undefined);
    const bob = named(undefined);
    save([alice, bob]);
    const base = loadBoard(core.database, workspaceId, board.id);
    const request = (node: CanvasNode): void => {
      saveBoard(core.database, workspaceId, board.id, {
        expectedUpdatedAt: base.board.updatedAt,
        nodes: base.nodes.map((entry) =>
          entry.id === node.id
            ? { ...entry, data: { ...(entry.data as object), handle: "rev" } }
            : entry,
        ),
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      });
    };
    request(alice);
    expect(() => request(bob)).toThrowError();
    expect(handleForNode(core.database, alice.id)).toBe("rev");
    expect(handleForNode(core.database, bob.id)).toBeUndefined();
  });

  it("releases the name when the node is deleted", () => {
    const alice = named("reviewer");
    const bob = named(undefined);
    save([alice, bob]);
    save([bob]);
    expect(handleForNode(core.database, alice.id)).toBeUndefined();
    expect(nodeNamed(core.database, board.id, "reviewer")).toBeUndefined();
    // 释放之后别人可以用它。
    save([{ ...bob, data: { ...(bob.data as object), handle: "reviewer" } }]);
    expect(handleForNode(core.database, bob.id)).toBe("reviewer");
  });

  it("releases the name when the node is merely renamed away", () => {
    const alice = named("reviewer");
    save([alice]);
    save([{ ...alice, data: { kind: "sticky", content: "hello" } }]);
    expect(handleForNode(core.database, alice.id)).toBeUndefined();
  });

  /**
   * 跨画布移动今天走「从这块删掉、在那块建出来」：`saveBoard` 的 upsert 有一条
   * `WHERE nodes.board_id = excluded.board_id`，不让一行被另一块画布抢走。名字
   * 跟着节点走，落点已经有人叫这个名字就拒绝，不静默改名（设计 §2.5 第 3 条）。
   */
  it("carries the name to another board, and refuses a landing that collides", () => {
    const other = createBoard(core.database, workspaceId, "Other");
    const alice = named("reviewer");
    save([alice]);
    save([]);

    save([{ ...alice, boardId: other.id }], other);
    expect(handleForNode(core.database, alice.id)).toBe("reviewer");
    expect(nodeNamed(core.database, other.id, "reviewer")?.id).toBe(alice.id);
    expect(nodeNamed(core.database, board.id, "reviewer")).toBeUndefined();

    const third = createBoard(core.database, workspaceId, "Third");
    const holder = { ...named("reviewer", third), title: "已经叫这个" };
    save([holder], third);
    const arriving = named("reviewer", third);
    expect(() => save([holder, arriving], third)).toThrowError(/已经叫这个/);
    expect(nodeNamed(core.database, other.id, "reviewer")?.id).toBe(alice.id);
    expect(handleForNode(core.database, arriving.id)).toBeUndefined();
  });

  it("keeps the rendered copy and the table saying the same thing", () => {
    // 这是 §11-A 那条风险的守卫：副本从表写出，两者只有一个写入点。
    const alice = named("Reviewer");
    save([alice]);
    const stored = loadBoard(core.database, workspaceId, board.id).nodes.find(
      (node) => node.id === alice.id,
    );
    // 副本是原样的 `Reviewer`，表是折叠后的 `reviewer`；解析永远读表，所以
    // 两者说的是同一个名字。
    expect(handleForNode(core.database, alice.id)).toBe("reviewer");
    expect(
      normalizeHandle(String((stored?.data as { handle: string }).handle)),
    ).toBe(handleForNode(core.database, alice.id));

    save([{ ...alice, data: { kind: "sticky", content: "hello" } }]);
    const after = loadBoard(core.database, workspaceId, board.id).nodes.find(
      (node) => node.id === alice.id,
    );
    expect((after?.data as { handle?: string }).handle).toBeUndefined();
    expect(handleForNode(core.database, alice.id)).toBeUndefined();
  });

  it("ignores a copy no rename verb would have accepted", () => {
    const alice = named("has space");
    save([alice]);
    expect(handleForNode(core.database, alice.id)).toBeUndefined();
  });
});
