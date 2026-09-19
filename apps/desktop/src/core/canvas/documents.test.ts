import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, fixture } from "../workspaces/fixture";
import { uuidV7 } from "../workspaces/support";
import { createWorkspace } from "../workspaces/table";
import { type Board, listBoards } from "./boards";
import { getContextLinks, putContextLinks } from "./context-links";
import type { CanvasNode } from "./document-types";
import { loadBoard, saveBoard } from "./documents";
import { linkEdge, stickyNode } from "./nodes.fixture";
import { MAX_WHITEBOARD_BYTES } from "./validation";

/**
 * Board documents, ported from `apps/runtime/src/db/tests/documents.rs`: the
 * incremental save that keeps a board's mailbox alive, the orphan sweep's
 * line between state and receipts, the whiteboard's keep/overwrite/bound
 * rules, and the CAS.
 */
describe("board documents", () => {
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

  /**
   * A message written the way the mailbox writes one. Only the two node
   * columns matter here: they are the `ON DELETE CASCADE` foreign keys a
   * delete-and-reinsert save used to take out.
   */
  function seedMessage(source: string, target: string): void {
    core.database
      .prepare(
        "INSERT INTO agent_mailbox (id, workspace_id, source_node_id, target_node_id, " +
          "message_key, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'ping', 0, 9999999999)",
      )
      .run(uuidV7(), workspaceId, source, target, uuidV7());
  }

  function count(sql: string): number {
    return Number((core.database.prepare(sql).get() as { n: number }).n);
  }

  it("keeps the mailbox when a node is only moved", () => {
    const alice = stickyNode(board.id);
    const bob = stickyNode(board.id);
    const edge = linkEdge(board.id, alice.id, bob.id);
    const saved = saveBoard(core.database, workspaceId, board.id, {
      expectedUpdatedAt: board.updatedAt,
      nodes: [alice, bob],
      edges: [edge],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    seedMessage(alice.id, bob.id);
    seedMessage(bob.id, alice.id);
    expect(count("SELECT COUNT(*) AS n FROM agent_mailbox")).toBe(2);

    const moved: CanvasNode = {
      ...alice,
      position: { x: 420, y: 96 },
      title: "Renamed",
    };
    const after = saveBoard(core.database, workspaceId, board.id, {
      expectedUpdatedAt: saved.board.updatedAt,
      nodes: [moved, bob],
      edges: [edge],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    expect(
      count("SELECT COUNT(*) AS n FROM agent_mailbox"),
      "an autosave must not empty the board's inboxes",
    ).toBe(2);

    const aliceAfter = after.nodes.find((node) => node.id === alice.id);
    expect(aliceAfter?.position.x).toBe(420);
    expect(aliceAfter?.title).toBe("Renamed");
    expect(after.edges).toHaveLength(1);
    expect(after.board.updatedAt).not.toBe(saved.board.updatedAt);

    // A third save changes nothing at all and still must not touch the mailbox.
    saveBoard(core.database, workspaceId, board.id, {
      expectedUpdatedAt: after.board.updatedAt,
      nodes: [alice, bob],
      edges: [edge],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    expect(count("SELECT COUNT(*) AS n FROM agent_mailbox")).toBe(2);
  });

  it("cascades only the deleted node's own mailbox", () => {
    const alice = stickyNode(board.id);
    const bob = stickyNode(board.id);
    const carol = stickyNode(board.id);
    const saved = saveBoard(core.database, workspaceId, board.id, {
      expectedUpdatedAt: board.updatedAt,
      nodes: [alice, bob, carol],
      edges: [linkEdge(board.id, alice.id, bob.id)],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    seedMessage(alice.id, bob.id);
    seedMessage(bob.id, carol.id);
    seedMessage(alice.id, carol.id);
    core.database
      .prepare(
        "INSERT INTO agent_status(node_id, workspace_id, agent_id, state, updated_at) " +
          "VALUES(?, ?, 'claude', 'working', '2026-09-07T00:00:00Z')",
      )
      .run(bob.id, workspaceId);

    // Bob leaves the board; his edge goes with him.
    saveBoard(core.database, workspaceId, board.id, {
      expectedUpdatedAt: saved.board.updatedAt,
      nodes: [alice, carol],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    const survivors = core.database
      .prepare(
        "SELECT source_node_id, target_node_id FROM agent_mailbox ORDER BY sequence",
      )
      .all() as unknown as {
      source_node_id: string;
      target_node_id: string;
    }[];
    expect(
      survivors,
      "only the messages that touched the deleted node are gone",
    ).toEqual([{ source_node_id: alice.id, target_node_id: carol.id }]);
    expect(count("SELECT COUNT(*) AS n FROM edges")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM nodes")).toBe(2);
    // `agent_status.node_id` is a plain column with no foreign key, so
    // nothing cascades there — the orphan sweep is what takes it.
    expect(count("SELECT COUNT(*) AS n FROM agent_status")).toBe(0);
  });

  it("drops a deleted node's live rows and keeps its receipts", () => {
    const alice = stickyNode(board.id);
    const bob = stickyNode(board.id);
    const saved = saveBoard(core.database, workspaceId, board.id, {
      expectedUpdatedAt: board.updatedAt,
      nodes: [alice, bob],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    const run = (sql: string, ...values: string[]): void => {
      core.database.prepare(sql).run(...values);
    };
    // One open question and one somebody answered.
    run(
      "INSERT INTO agent_approvals(id, node_id, workspace_id, request_json, created_at) " +
        "VALUES('approval-open', ?, ?, '{}', '2026-09-07T00:00:00Z')",
      bob.id,
      workspaceId,
    );
    run(
      "INSERT INTO agent_approvals(id, node_id, workspace_id, request_json, answer, answered_at, created_at) " +
        "VALUES('approval-answered', ?, ?, '{}', 'allow', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z')",
      bob.id,
      workspaceId,
    );
    run(
      "INSERT INTO context_links(node_id, workspace_id, links_json, updated_at) " +
        "VALUES(?, ?, '[]', '2026-09-07T00:00:00Z')",
      bob.id,
      workspaceId,
    );
    run(
      "INSERT INTO agent_deliveries(trace_id, workspace_id, source_node_id, target_node_id, outcome, created_at) " +
        "VALUES('trace-1', ?, ?, ?, 'submitted', '2026-09-07T00:00:00Z')",
      workspaceId,
      alice.id,
      bob.id,
    );
    run(
      "INSERT INTO agent_handoffs(id, workspace_id, source_node_id, source_session_id, source_generation, " +
        "target_node_id, target_session_id, target_generation, bundle_json, bundle_digest, state, created_at, updated_at) " +
        "VALUES('handoff-1', ?, ?, 's-1', 1, ?, 's-2', 1, '{}', 'digest', 'prepared', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z')",
      workspaceId,
      alice.id,
      bob.id,
    );
    run(
      "INSERT INTO agent_handoff_outbox(handoff_id, state, created_at) " +
        "VALUES('handoff-1', 'pending', '2026-09-07T00:00:00Z')",
    );
    run(
      "INSERT INTO terminal_sessions(id, workspace_id, owner_node_id, cwd, shell, status, created_at) " +
        "VALUES('session-1', ?, ?, '/tmp', 'zsh', 'running', '2026-09-07T00:00:00Z')",
      workspaceId,
      bob.id,
    );

    saveBoard(core.database, workspaceId, board.id, {
      expectedUpdatedAt: saved.board.updatedAt,
      nodes: [alice],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    expect(
      count("SELECT COUNT(*) AS n FROM context_links"),
      "a link document outlived the edges it was derived from",
    ).toBe(0);
    expect(
      count("SELECT COUNT(*) AS n FROM agent_approvals WHERE answer IS NULL"),
      "a question nobody can answer stayed open",
    ).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM agent_approvals WHERE answer IS NOT NULL",
      ),
      "an answered question is a receipt and must survive",
    ).toBe(1);
    expect(
      count("SELECT COUNT(*) AS n FROM agent_handoff_outbox"),
      "a pending dispatch nobody can complete stayed queued",
    ).toBe(0);
    // Receipts stay: identities survive node deletion so historical receipts
    // remain honest.
    expect(count("SELECT COUNT(*) AS n FROM agent_handoffs")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM agent_deliveries")).toBe(1);
    // The process outlives the node on purpose: a person decides what
    // happens to a running program.
    expect(count("SELECT COUNT(*) AS n FROM terminal_sessions")).toBe(1);
  });

  it("adds, removes and keeps rows in one pass, and refuses a stale revision", () => {
    const kept = stickyNode(board.id);
    const dropped = stickyNode(board.id);
    const saved = saveBoard(core.database, workspaceId, board.id, {
      expectedUpdatedAt: board.updatedAt,
      nodes: [kept, dropped],
      edges: [linkEdge(board.id, kept.id, dropped.id)],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    const added = stickyNode(board.id);
    const freshEdge = linkEdge(board.id, kept.id, added.id);
    seedMessage(kept.id, dropped.id);

    const after = saveBoard(core.database, workspaceId, board.id, {
      expectedUpdatedAt: saved.board.updatedAt,
      nodes: [kept, added],
      edges: [freshEdge],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    expect(count("SELECT COUNT(*) AS n FROM nodes")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM edges")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM agent_mailbox")).toBe(0);
    const ids = new Set(after.nodes.map((node) => node.id));
    expect(ids.has(kept.id) && ids.has(added.id)).toBe(true);
    expect(after.edges[0]?.id).toBe(freshEdge.id);

    // Stale revision: still a 409, and the board it refused is untouched.
    expect(() =>
      saveBoard(core.database, workspaceId, board.id, {
        expectedUpdatedAt: saved.board.updatedAt,
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
    ).toThrowError(/reload before saving/);
    expect(count("SELECT COUNT(*) AS n FROM nodes")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM edges")).toBe(1);
  });

  it("keeps, overwrites and bounds the whiteboard snapshot", () => {
    expect(board.whiteboard, "0009 defaults to no whiteboard").toBe("");
    const snapshot =
      '{"engine":"armadra-flow","version":2,"items":[{"kind":"ink"}]}';
    const saved = saveBoard(core.database, workspaceId, board.id, {
      expectedUpdatedAt: board.updatedAt,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: snapshot,
    });
    expect(saved.board.whiteboard).toBe(snapshot);
    // It survives a reload, and it is on the board brief too.
    expect(
      loadBoard(core.database, workspaceId, board.id).board.whiteboard,
    ).toBe(snapshot);
    expect(listBoards(core.database, workspaceId)[0]?.whiteboard).toBe(
      snapshot,
    );

    // A client that knows nothing about the whiteboard saves a node and must
    // not wipe the drawing.
    const kept = saveBoard(core.database, workspaceId, board.id, {
      expectedUpdatedAt: saved.board.updatedAt,
      nodes: [stickyNode(board.id)],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    expect(kept.board.whiteboard).toBe(snapshot);

    // An explicit empty string is how the client says "I erased it".
    const cleared = saveBoard(core.database, workspaceId, board.id, {
      expectedUpdatedAt: kept.board.updatedAt,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: "",
    });
    expect(cleared.board.whiteboard).toBe("");

    expect(() =>
      saveBoard(core.database, workspaceId, board.id, {
        expectedUpdatedAt: cleared.board.updatedAt,
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        whiteboard: "x".repeat(MAX_WHITEBOARD_BYTES + 1),
      }),
    ).toThrowError(/too large/);
  });

  it("round-trips a shape link's own readable content", () => {
    const nodeId = uuidV7();
    const shapeId = uuidV7();
    putContextLinks(core.database, workspaceId, nodeId, [
      {
        id: shapeId,
        title: "架构图",
        kind: "shape",
        content: {
          text: "runtime -> web",
          pngPath: ".armadra/exports/diagram.png",
        },
      },
    ]);
    const stored = getContextLinks(core.database, nodeId);
    expect(stored.links[0]?.content?.text).toBe("runtime -> web");
    expect(stored.links[0]?.content?.pngPath).toBe(
      ".armadra/exports/diagram.png",
    );

    expect(() =>
      putContextLinks(core.database, workspaceId, nodeId, [
        {
          id: shapeId,
          title: "太大",
          kind: "shape",
          content: { text: "x".repeat(20_001) },
        },
      ]),
    ).toThrowError(/too large/);
  });

  it("rejects a stale board revision", () => {
    saveBoard(core.database, workspaceId, board.id, {
      expectedUpdatedAt: board.updatedAt,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    expect(() =>
      saveBoard(core.database, workspaceId, board.id, {
        expectedUpdatedAt: board.updatedAt,
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
    ).toThrowError(/reload before saving/);
  });
});
