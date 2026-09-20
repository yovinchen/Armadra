import { describe, expect, it, afterEach } from "vitest";

import { fixture, type Fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { listSessions } from "./install";

/**
 * `GET /api/workspaces/{id}/sessions` 每个节点只报一行。
 *
 * 打包验收里同一个节点出现四次、三次是死的：那些行都是真的，只是「这个节点
 * 现在在跑什么」只有一个答案。这里直接往库里写多行，因为要测的正是**已经积
 * 下来的历史**——用真 PTY 攒出同样的历史要重启节点三次。
 */

let open: Fixture | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
});

async function board(): Promise<{
  core: Fixture;
  workspaceId: string;
  boardId: string;
}> {
  open = fixture([installWorkspaces]);
  const created = await open.call("POST", "/api/workspaces", {
    name: "Canvas",
    rootPath: open.directory,
  });
  const workspaceId = (created.body as { id: string }).id;
  const boardId = "board-1";
  const at = new Date().toISOString();
  open.database
    .prepare(
      "INSERT INTO boards (id, workspace_id, name, sort_order, created_at, updated_at) VALUES (?, ?, 'B', 0, ?, ?)",
    )
    .run(boardId, workspaceId, at, at);
  return { core: open, workspaceId, boardId };
}

function node(core: Fixture, boardId: string, id: string, title: string): void {
  const at = new Date().toISOString();
  core.database
    .prepare(
      "INSERT INTO nodes (id, board_id, type, x, y, title, data_json, created_at, updated_at) " +
        "VALUES (?, ?, 'terminal', 0, 0, ?, '{}', ?, ?)",
    )
    .run(id, boardId, title, at, at);
}

function session(
  core: Fixture,
  workspaceId: string,
  nodeId: string,
  id: string,
  createdAt: string,
): void {
  core.database
    .prepare(
      "INSERT INTO terminal_sessions (id, workspace_id, owner_node_id, cwd, shell, status, created_at) " +
        "VALUES (?, ?, ?, '/tmp', '/bin/sh', 'running', ?)",
    )
    .run(id, workspaceId, nodeId, createdAt);
}

describe("工作空间的会话列表", () => {
  it("一个节点攒下四行历史，只报还活着的那一行", async () => {
    const { core, workspaceId, boardId } = await board();
    node(core, boardId, "node-a", "Agent");
    session(core, workspaceId, "node-a", "s-old-1", "2026-09-01T00:00:00Z");
    session(core, workspaceId, "node-a", "s-old-2", "2026-09-02T00:00:00Z");
    session(core, workspaceId, "node-a", "s-live", "2026-09-03T00:00:00Z");
    session(core, workspaceId, "node-a", "s-old-3", "2026-09-04T00:00:00Z");

    const listed = listSessions(
      core.database,
      workspaceId,
      (id) => id === "s-live",
    );
    expect(listed.map((row) => row.sessionId)).toEqual(["s-live"]);
    expect(listed[0]?.alive).toBe(true);
  });

  it("一行都没活着时报最新那一行，因为重附会接上它", async () => {
    const { core, workspaceId, boardId } = await board();
    node(core, boardId, "node-a", "Agent");
    session(core, workspaceId, "node-a", "s-older", "2026-09-01T00:00:00Z");
    session(core, workspaceId, "node-a", "s-newest", "2026-09-05T00:00:00Z");

    const listed = listSessions(core.database, workspaceId, () => false);
    expect(listed.map((row) => row.sessionId)).toEqual(["s-newest"]);
    expect(listed[0]?.alive).toBe(false);
  });

  it("两个节点还是两行，去重只在节点内部发生", async () => {
    const { core, workspaceId, boardId } = await board();
    node(core, boardId, "node-a", "A");
    node(core, boardId, "node-b", "B");
    session(core, workspaceId, "node-a", "s-a", "2026-09-01T00:00:00Z");
    session(core, workspaceId, "node-b", "s-b", "2026-09-02T00:00:00Z");

    const listed = listSessions(core.database, workspaceId, () => true);
    // 最新的在前：面板按 `created_at DESC` 显示。
    expect(listed.map((row) => row.nodeId)).toEqual(["node-b", "node-a"]);
  });
});
