import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceEvent } from "../bus";
import { type Fixture, fixture } from "../workspaces/fixture";
import { uuidV7 } from "../workspaces/support";
import { install as installWorkspaces } from "../workspaces/routes";
import { install } from "./routes";

/**
 * The board routes, ported from the pre-merge implementation: the
 * v3 contract of the document pair, the retired-kanban rejection and the CAS
 * a second save runs into.
 */
describe("the board routes", () => {
  let core: Fixture;
  let workspaceId: string;
  let boardId: string;
  let documentUri: string;

  beforeEach(async () => {
    core = fixture([installWorkspaces, install]);
    const created = await core.call("POST", "/api/workspaces", {
      name: "Canvas",
      rootPath: core.directory,
      color: "#123456",
    });
    workspaceId = (created.body as { id: string }).id;
    const boards = await core.call(
      "GET",
      `/api/workspaces/${workspaceId}/boards`,
    );
    boardId = ((boards.body as { id: string }[])[0] as { id: string }).id;
    documentUri = `/api/workspaces/${workspaceId}/boards/${boardId}/document`;
  });
  afterEach(() => {
    core.close();
  });

  it("rejects a retired task-board payload before any database write", async () => {
    for (const retired of [null, { columns: [], cards: {} }]) {
      const answer = await core.call("PUT", documentUri, {
        expectedUpdatedAt: "2026-09-05T00:00:00Z",
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        kanban: retired,
      });
      expect(answer.status).toBe(400);
      expect(String((answer.body as { message: string }).message)).toContain(
        "retired",
      );
    }
    // A board nobody would have reached anyway: the check runs first, so a
    // path with no board still answers 400 rather than 404.
    const missing = await core.call(
      "PUT",
      `/api/workspaces/${workspaceId}/boards/${uuidV7()}/document`,
      {
        expectedUpdatedAt: "2026-09-05T00:00:00Z",
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        kanban: null,
      },
    );
    expect(missing.status).toBe(400);
  });

  it("follows the v3 contract for the document pair", async () => {
    const loaded = await core.call("GET", documentUri);
    expect(loaded.status).toBe(200);
    const document = loaded.body as {
      board: { whiteboard: string; updatedAt: string };
      nodes: unknown[];
    };
    expect("strokes" in (loaded.body as object)).toBe(false);
    // Migration 0009: a board that was never drawn on still reports the key.
    expect(document.board.whiteboard).toBe("");

    const now = new Date().toISOString().replace("Z", "+00:00");
    const groupId = uuidV7();
    const terminalId = uuidV7();
    const body = {
      expectedUpdatedAt: document.board.updatedAt,
      nodes: [
        {
          id: groupId,
          boardId,
          type: "group",
          title: "Worktree",
          color: "#32d74b",
          position: { x: 0, y: 0 },
          size: { width: 520, height: 360 },
          data: { kind: "group" },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: terminalId,
          boardId,
          type: "terminal",
          title: "Claude",
          position: { x: 10, y: 20 },
          size: { width: 640, height: 440 },
          collapsed: true,
          expandedHeight: 440,
          parentId: groupId,
          data: {
            kind: "terminal",
            cwd: ".",
            shell: "/bin/zsh",
            agent: { id: "claude", permissionMode: "auto-edit" },
          },
          createdAt: now,
          updatedAt: now,
        },
      ],
      edges: [
        {
          id: uuidV7(),
          boardId,
          source: groupId,
          target: terminalId,
          kind: "link",
          createdAt: now,
          updatedAt: now,
        },
      ],
      viewport: { x: -12, y: 8, zoom: 0.5 },
      whiteboard: '{"store":{}}',
    };

    const frames: { workspaceId: string; event: WorkspaceEvent }[] = [];
    core.bus.on("workspace.event", (frame) => frames.push(frame));

    const saved = await core.call("PUT", documentUri, body);
    expect(saved.status).toBe(200);
    const after = saved.body as {
      board: { whiteboard: string; updatedAt: string };
      nodes: Record<string, unknown>[];
      edges: Record<string, unknown>[];
    };
    // The save response and the next load both carry the snapshot back.
    expect(after.board.whiteboard).toBe('{"store":{}}');
    const reloaded = await core.call("GET", documentUri);
    expect(
      (reloaded.body as { board: { whiteboard: string } }).board.whiteboard,
    ).toBe('{"store":{}}');
    expect(after.nodes[0]?.title).toBe("Worktree");
    expect(after.nodes[0]?.color).toBe("#32d74b");
    // The palette default is applied to a node that named no colour.
    expect(after.nodes[1]?.color).toBe("#0a84ff");
    expect(after.nodes[1]?.parentId).toBe(groupId);
    expect(after.nodes[1]?.collapsed).toBe(true);
    expect(after.edges[0]?.kind).toBe("link");
    expect("zoom" in (after.nodes[0] as object)).toBe(false);
    expect("strokes" in (saved.body as object)).toBe(false);

    // `board.changed` carries exactly the two contractual fields, and the
    // workspace id rides beside the frame rather than inside it.
    expect(frames).toEqual([
      {
        workspaceId,
        event: {
          type: "board.changed",
          boardId,
          updatedAt: after.board.updatedAt,
        },
      },
    ]);

    // The same body a second time is a stale revision.
    const conflict = await core.call("PUT", documentUri, body);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "conflict" });
  });

  it("creates, renames and deletes boards through the routes", async () => {
    const created = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/boards`,
      { name: "Review" },
    );
    expect(created.status).toBe(200);
    const extra = created.body as { id: string; sortOrder: number };
    expect(extra.sortOrder).toBe(1);

    const renamed = await core.call(
      "PATCH",
      `/api/workspaces/${workspaceId}/boards/${extra.id}`,
      { name: "Reviewed", sortOrder: 0 },
    );
    expect(renamed.body).toMatchObject({ name: "Reviewed", sortOrder: 0 });

    const removed = await core.call(
      "DELETE",
      `/api/workspaces/${workspaceId}/boards/${extra.id}`,
    );
    expect(removed.status).toBe(204);

    const last = await core.call(
      "DELETE",
      `/api/workspaces/${workspaceId}/boards/${boardId}`,
    );
    expect(last.status).toBe(409);
  });

  it("stores a node's context-link document and bounds it", async () => {
    const nodeId = uuidV7();
    const uri = `/api/workspaces/${workspaceId}/context-links/${nodeId}`;
    const stored = await core.call("PUT", uri, {
      links: [{ id: uuidV7(), title: "Claude", kind: "node" }],
    });
    expect(stored.status).toBe(200);
    expect(stored.body).toMatchObject({ nodeId });
    expect((stored.body as { links: unknown[] }).links).toHaveLength(1);

    // An empty document is how the canvas says "this node links nothing".
    const emptied = await core.call("PUT", uri, { links: [] });
    expect((emptied.body as { links: unknown[] }).links).toHaveLength(0);

    const tooMany = await core.call("PUT", uri, {
      links: Array.from({ length: 65 }, () => ({
        id: uuidV7(),
        title: "x",
        kind: "node",
      })),
    });
    expect(tooMany.status).toBe(400);

    const notAUuid = await core.call(
      "PUT",
      `/api/workspaces/${workspaceId}/context-links/not-a-uuid`,
      { links: [] },
    );
    expect(notAUuid.status).toBe(400);

    const unknownWorkspace = await core.call(
      "PUT",
      `/api/workspaces/${uuidV7()}/context-links/${nodeId}`,
      { links: [] },
    );
    expect(unknownWorkspace.status).toBe(404);
  });

  describe("presence and the edit lease (contract §9)", () => {
    const A = "tab-aaaaaaaaaaaa";
    const B = "tab-bbbbbbbbbbbb";
    let presenceUri: string;
    let leaseUri: string;

    beforeEach(() => {
      presenceUri = `/api/workspaces/${workspaceId}/boards/${boardId}/presence`;
      leaseUri = `/api/workspaces/${workspaceId}/boards/${boardId}/lease`;
    });

    async function save(clientId?: string) {
      const loaded = await core.call("GET", documentUri);
      const document = loaded.body as { board: { updatedAt: string } };
      return core.call("PUT", documentUri, {
        expectedUpdatedAt: document.board.updatedAt,
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        ...(clientId === undefined ? {} : { clientId }),
      });
    }

    it("is invisible to a single client: its heartbeat takes the lease and its saves go through", async () => {
      const frames: { event: WorkspaceEvent }[] = [];
      core.bus.on("workspace.event", (frame) => frames.push(frame));
      const beat = await core.call("POST", presenceUri, {
        clientId: A,
        deviceName: "MacBook",
      });
      expect(beat.status).toBe(200);
      expect(beat.body).toMatchObject({
        boardId,
        writable: true,
        lease: { clientId: A, deviceName: "MacBook" },
        clients: [{ clientId: A, deviceName: "MacBook" }],
      });
      expect((await save(A)).status).toBe(200);
      expect((await save(A)).status).toBe(200);
      const presenceFrames = frames.filter(
        (frame) => frame.event.type === "canvas.presence",
      );
      expect(presenceFrames).toHaveLength(1);
    });

    it("rejects a second client's save with 423 until it takes over", async () => {
      await core.call("POST", presenceUri, { clientId: A, deviceName: "Mac" });
      const second = await core.call("POST", presenceUri, {
        clientId: B,
        deviceName: "iPad",
        active: true,
      });
      expect(second.body).toMatchObject({ lease: { clientId: A } });

      const refused = await save(B);
      expect(refused.status).toBe(423);
      expect(refused.body).toMatchObject({ code: "canvas_lease_held" });
      // 没有身份的写者也不能绕过别人手里的租约。
      expect((await save()).status).toBe(423);

      const asked = await core.call("POST", leaseUri, { clientId: B });
      expect(asked.status).toBe(423);
      const taken = await core.call("POST", leaseUri, {
        clientId: B,
        deviceName: "iPad",
        takeover: true,
      });
      expect(taken.status).toBe(200);
      expect(taken.body).toMatchObject({ lease: { clientId: B } });

      expect((await save(B)).status).toBe(200);
      expect((await save(A)).status).toBe(423);
    });

    it("still answers a stale revision with 409 for the lease holder", async () => {
      await core.call("POST", presenceUri, { clientId: A });
      const stale = await core.call("PUT", documentUri, {
        expectedUpdatedAt: "2020-01-01T00:00:00+00:00",
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        clientId: A,
      });
      expect(stale.status).toBe(409);
    });

    it("releases the lease when its holder leaves", async () => {
      await core.call("POST", presenceUri, { clientId: A });
      await core.call("POST", presenceUri, { clientId: B });
      const left = await core.call("DELETE", `${presenceUri}/${A}`);
      expect(left.status).toBe(200);
      expect(left.body).toMatchObject({ lease: { clientId: B } });
      expect((await save(B)).status).toBe(200);
    });

    it("validates the client id and the board", async () => {
      expect(
        (await core.call("POST", presenceUri, { clientId: "x" })).status,
      ).toBe(400);
      expect(
        (
          await core.call(
            "POST",
            `/api/workspaces/${workspaceId}/boards/${uuidV7()}/presence`,
            { clientId: A },
          )
        ).status,
      ).toBe(404);
      const bad = await core.call("PUT", documentUri, {
        expectedUpdatedAt: "2020-01-01T00:00:00+00:00",
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        clientId: 7,
      });
      expect(bad.status).toBe(400);
    });
  });
});
