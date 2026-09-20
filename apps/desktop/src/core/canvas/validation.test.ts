import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, fixture } from "../workspaces/fixture";
import { uuidV7 } from "../workspaces/support";
import { createWorkspace } from "../workspaces/table";
import { listBoards } from "./boards";
import type { CanvasNode } from "./document-types";
import { saveBoard } from "./documents";
import { linkEdge, stickyNode } from "./nodes.fixture";
import { BUILTIN_AGENT_IDS, NODE_TYPES, validateDocument } from "./validation";

/**
 * Document validation, ported from the pre-merge implementation's test
 * suites.
 */
describe("document validation", () => {
  let core: Fixture;
  let workspaceId: string;
  let boardId: string;
  let boardUpdatedAt: string;

  beforeEach(() => {
    core = fixture([]);
    const workspace = createWorkspace(core.database, {
      name: "fixture",
      rootPath: core.directory,
    });
    workspaceId = workspace.id;
    const board = listBoards(core.database, workspaceId)[0];
    if (board === undefined) throw new Error("the default board is missing");
    boardId = board.id;
    boardUpdatedAt = board.updatedAt;
  });
  afterEach(() => {
    core.close();
  });

  function withData(type: string, data: unknown): CanvasNode {
    return { ...stickyNode(boardId), type, title: type, data };
  }

  it("accepts every v3 node kind", () => {
    const payloads: Record<string, unknown>[] = [
      {
        kind: "terminal",
        cwd: ".",
        shell: "/bin/zsh",
        agent: {
          id: "claude",
          permissionMode: "plan",
          model: "opus",
          initialCommand: "claude --permission-mode plan",
        },
      },
      { kind: "sticky", content: "hello" },
      { kind: "group" },
      { kind: "editor", path: "src/App.tsx", language: "tsx", readonly: false },
      { kind: "diff", repoPath: ".", scope: "staged", paths: ["a.ts"] },
      { kind: "files", path: "src" },
      { kind: "browser", url: "https://example.com" },
      {
        kind: "automation",
        planId: "plan-1",
        planWorkspaceId: "workspace-1",
        executionHostId: "0123456789abcdef0123456789abcdef",
        scheduleKind: "interval",
      },
      {
        kind: "agentActivity",
        sourceNodeId: "3f0d6a4e-6f3d-4c9a-9f2b-1c0f5a7d8e21",
        source: "subagent",
      },
    ];
    expect(payloads).toHaveLength(NODE_TYPES.length);
    const nodes = payloads.map((data) => withData(data.kind as string, data));
    // Park the sticky inside the group to exercise parent/child validation.
    const group = nodes.find((node) => node.type === "group");
    if (group === undefined) throw new Error("no group node");
    nodes[1] = {
      ...(nodes[1] as CanvasNode),
      parentId: group.id,
      collapsed: true,
      expandedHeight: 200,
    };

    const first = nodes[0] as CanvasNode;
    const second = nodes[1] as CanvasNode;
    const saved = saveBoard(core.database, workspaceId, boardId, {
      expectedUpdatedAt: boardUpdatedAt,
      nodes,
      edges: [linkEdge(boardId, first.id, second.id)],
      viewport: { x: 12, y: -8, zoom: 0.75 },
    });
    expect(saved.nodes).toHaveLength(NODE_TYPES.length);
    expect(saved.edges).toHaveLength(1);
    expect(saved.edges[0]?.kind).toBe("link");
    expect(saved.board.viewport.zoom).toBe(0.75);
    const sticky = saved.nodes.find((node) => node.type === "sticky");
    expect(sticky?.collapsed).toBe(true);
    expect(sticky?.expandedHeight).toBe(200);
    expect(sticky?.parentId).toBe(group.id);
  });

  it("rejects retired types and edge kinds", () => {
    for (const retired of ["task", "agent", "note", "file", "context", "log"]) {
      const node = withData(retired, { kind: retired, content: "x" });
      expect(
        () => validateDocument(boardId, [node], []),
        `${retired} was accepted`,
      ).toThrowError();
    }
    const source = stickyNode(boardId);
    const target = stickyNode(boardId);
    const edge = {
      ...linkEdge(boardId, source.id, target.id),
      kind: "dispatch",
    };
    expect(() =>
      validateDocument(boardId, [source, target], [edge]),
    ).toThrowError();
  });

  it("rejects invalid headers, parents and agents", () => {
    expect(() =>
      validateDocument(boardId, [{ ...stickyNode(boardId), title: "" }], []),
    ).toThrowError();
    expect(() =>
      validateDocument(boardId, [{ ...stickyNode(boardId), color: "red" }], []),
    ).toThrowError();

    // A parent that is not a group node in the same document is rejected.
    const parent = stickyNode(boardId);
    const child = { ...stickyNode(boardId), parentId: parent.id };
    expect(() => validateDocument(boardId, [parent, child], [])).toThrowError();

    const terminal = (agent: unknown): CanvasNode =>
      withData("terminal", { kind: "terminal", agent });
    expect(() =>
      validateDocument(boardId, [terminal({ id: "unknown-cli" })], []),
    ).toThrowError();
    for (const id of BUILTIN_AGENT_IDS) {
      expect(() =>
        validateDocument(boardId, [terminal({ id })], []),
      ).not.toThrow();
    }
    expect(() =>
      validateDocument(boardId, [terminal({ id: "custom:mytool" })], []),
    ).not.toThrow();
    expect(() =>
      validateDocument(
        boardId,
        [terminal({ id: "claude", permissionMode: "yolo" })],
        [],
      ),
    ).toThrowError();
  });

  it("lets an activity card carry the recurrence rule it observed", () => {
    const card = (nativeRecurrence: unknown): CanvasNode =>
      withData("agentActivity", {
        kind: "agentActivity",
        sourceNodeId: "3f0d6a4e-6f3d-4c9a-9f2b-1c0f5a7d8e21",
        nativeRecurrence,
      });
    for (const accepted of [
      { dialect: "cron", rule: "0 3 * * *", timezone: "Asia/Shanghai" },
      // No timezone: a crontab line does not carry one, and the panel asks.
      { dialect: "launchd", rule: '{"StartInterval":900}' },
      // Something no parser understands is still stored as written.
      { dialect: "cron", rule: "@reboot" },
    ]) {
      expect(
        () => validateDocument(boardId, [card(accepted)], []),
        JSON.stringify(accepted),
      ).not.toThrow();
    }
    for (const rejected of [
      { dialect: "systemd", rule: "OnCalendar=daily" },
      { dialect: "cron" },
      { dialect: "cron", rule: "" },
      { dialect: "cron", rule: "*".repeat(2_001) },
      { dialect: "cron", rule: "0 3 * * *", timezone: "z".repeat(65) },
    ]) {
      expect(
        () => validateDocument(boardId, [card(rejected)], []),
        JSON.stringify(rejected),
      ).toThrowError();
    }
    // Absent is fine: a card built from Hook events reports iterations, not a
    // schedule, and must not be given an invented one.
    expect(() =>
      validateDocument(
        boardId,
        [
          withData("agentActivity", {
            kind: "agentActivity",
            sourceNodeId: "3f0d6a4e-6f3d-4c9a-9f2b-1c0f5a7d8e21",
          }),
        ],
        [],
      ),
    ).not.toThrow();
  });

  it("bounds labels and notes", () => {
    const board = uuidV7();
    const base = stickyNode(board);
    const withLabels = (labels: string[], note = ""): CanvasNode => ({
      ...base,
      labels,
      note,
    });
    expect(() =>
      validateDocument(
        board,
        [withLabels(Array.from({ length: 9 }, (_v, i) => `l${i}`))],
        [],
      ),
    ).toThrowError();
    expect(() =>
      validateDocument(board, [withLabels(["x".repeat(25)])], []),
    ).toThrowError();
    expect(() =>
      validateDocument(board, [withLabels(["  "])], []),
    ).toThrowError();
    expect(() =>
      validateDocument(board, [withLabels(["ok"], "n".repeat(4_001))], []),
    ).toThrowError();
    expect(() =>
      validateDocument(board, [withLabels(["ok"], "n".repeat(4_000))], []),
    ).not.toThrow();
  });

  it("keeps the palette defaults valid for every kind", () => {
    // the pre-merge implementation: the payload the front end mints for each
    // palette entry has to be one this validator accepts, or a fresh node
    // cannot be saved at all.
    const defaults: Record<string, unknown> = {
      terminal: { kind: "terminal" },
      sticky: { kind: "sticky", content: "" },
      group: { kind: "group" },
      editor: { kind: "editor", path: "README.md" },
      diff: { kind: "diff", repoPath: ".", scope: "worktree" },
      files: { kind: "files", path: "." },
      browser: { kind: "browser", url: "https://example.com" },
      automation: {
        kind: "automation",
        planId: "p",
        planWorkspaceId: "w",
        executionHostId: "h",
      },
      agentActivity: {
        kind: "agentActivity",
        sourceNodeId: "3f0d6a4e-6f3d-4c9a-9f2b-1c0f5a7d8e21",
      },
    };
    for (const type of NODE_TYPES) {
      expect(
        () => validateDocument(boardId, [withData(type, defaults[type])], []),
        type,
      ).not.toThrow();
    }
  });

  it("does not let an automation and an activity payload stand in for each other", () => {
    expect(() =>
      validateDocument(
        boardId,
        [
          withData("automation", {
            kind: "automation",
            sourceNodeId: "3f0d6a4e-6f3d-4c9a-9f2b-1c0f5a7d8e21",
          }),
        ],
        [],
      ),
    ).toThrowError();
    expect(() =>
      validateDocument(
        boardId,
        [
          withData("agentActivity", {
            kind: "agentActivity",
            planId: "p",
            planWorkspaceId: "w",
            executionHostId: "h",
          }),
        ],
        [],
      ),
    ).toThrowError();
  });

  it("keeps the reserved account binding optional and bounded", () => {
    const terminal = (agent: unknown): CanvasNode =>
      withData("terminal", { kind: "terminal", agent });
    expect(() =>
      validateDocument(boardId, [terminal({ id: "claude" })], []),
    ).not.toThrow();
    expect(() =>
      validateDocument(
        boardId,
        [
          terminal({
            id: "claude",
            account: {
              accountId: "a",
              providerId: "anthropic",
              label: "Work",
              credentialRef: "keychain:work",
            },
          }),
        ],
        [],
      ),
    ).not.toThrow();
    for (const account of [
      { accountId: "" },
      { accountId: "a".repeat(121) },
      { accountId: "a", providerId: "p".repeat(121) },
      { accountId: "a", label: "l".repeat(201) },
      { accountId: "a", credentialRef: "c".repeat(201) },
    ]) {
      expect(
        () =>
          validateDocument(boardId, [terminal({ id: "claude", account })], []),
        JSON.stringify(account),
      ).toThrowError();
    }
  });
});
