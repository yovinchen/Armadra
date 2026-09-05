import { describe, expect, it } from "vitest";
import {
  agentInfoSchema,
  answerApprovalRequestSchema,
  contextLinksRequestSchema,
  conversationRefreshResponseSchema,
  conversationsResponseSchema,
  createTerminalRequestSchema,
  gitCommitRequestSchema,
  gitDiffRequestSchema,
  gitFileDiffSchema,
  gitStatusSchema,
  gitUnstageResponseSchema,
  hookInstallReportSchema,
  saveBoardRequestSchema,
  sessionsResponseSchema,
  suggestTitleResponseSchema,
  terminalClientMessageSchema,
  terminalServerMessageSchema,
  terminalSessionSchema,
  workspaceEventSchema,
  writeFileRequestSchema,
  writeFileResponseSchema,
} from "../src/index.js";

const timestamp = "2026-08-13T00:00:00.000Z";
const uuid = "019ff7d1-5c48-7d75-a0ed-64b52f44e214";
const otherUuid = "019ff7d1-7419-74df-89e2-b1619d36ea7d";

describe("runtime API v3", () => {
  it("preserves Agent identity while accepting older terminal responses", () => {
    const session = {
      id: uuid,
      workspaceId: otherUuid,
      cwd: "/repo",
      shell: "/bin/sh",
      command: null,
      status: "running",
      exitCode: null,
      createdAt: timestamp,
      endedAt: null,
    };
    expect(terminalSessionSchema.parse(session).agentId).toBeUndefined();
    expect(
      terminalSessionSchema.parse({ ...session, agentId: null }).agentId,
    ).toBeNull();
    expect(
      terminalSessionSchema.parse({ ...session, agentId: "custom:helper" })
        .agentId,
    ).toBe("custom:helper");
  });
  it("no longer accepts strokes on a board save", () => {
    const parsed = saveBoardRequestSchema.parse({
      expectedUpdatedAt: timestamp,
      nodes: [],
      edges: [],
      strokes: [{ id: uuid, color: "#fff", width: 3, points: [] }],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    expect(parsed).not.toHaveProperty("strokes");
  });

  it("carries the optional agent block on a terminal request", () => {
    const parsed = createTerminalRequestSchema.parse({
      workspaceId: uuid,
      cwd: ".",
      nodeId: otherUuid,
      agent: { id: "claude", permissionMode: "auto-edit", model: "opus" },
    });
    expect(parsed.agent?.id).toBe("claude");
    expect(parsed.args).toEqual([]);
    expect(
      createTerminalRequestSchema.safeParse({
        workspaceId: uuid,
        cwd: ".",
        agent: { id: "not-an-agent" },
      }).success,
    ).toBe(false);
  });

  it("describes the sessions sidebar payload", () => {
    const sessions = sessionsResponseSchema.parse([
      {
        nodeId: uuid,
        boardId: otherUuid,
        sessionId: uuid,
        kind: "terminal",
        title: "Claude",
        cwd: "/repo",
        agentId: "claude",
        state: "blocked",
        unread: true,
        pendingId: "node-1-1-2",
        updatedAt: timestamp,
        alive: true,
      },
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.state).toBe("blocked");
    expect(sessions[0]?.alive).toBe(true);
  });

  it("describes an agent registry entry with local detection", () => {
    const info = agentInfoSchema.parse({
      id: "codex",
      label: "Codex",
      color: "#10a37f",
      launchCmd: "codex",
      promptMode: "argv",
      capabilities: ["hooks", "resume"],
      installed: true,
    });
    expect(info.resolvedPath).toBeNull();
    expect(info.capabilities).toContain("hooks");
  });

  it("validates approvals, context links and commits", () => {
    expect(
      answerApprovalRequestSchema.parse({ decision: "deny" }).decision,
    ).toBe("deny");
    expect(
      answerApprovalRequestSchema.safeParse({ decision: "maybe" }).success,
    ).toBe(false);
    expect(
      contextLinksRequestSchema.parse({
        links: [{ id: uuid, title: "Codex", kind: "terminal" }],
      }).links,
    ).toHaveLength(1);
    expect(contextLinksRequestSchema.parse({}).links).toEqual([]);
    expect(gitCommitRequestSchema.parse({ message: " ship v3 " }).message).toBe(
      "ship v3",
    );
    expect(gitCommitRequestSchema.safeParse({ message: "  " }).success).toBe(
      false,
    );
  });

  it("models the terminal socket in both directions", () => {
    for (const message of [
      { type: "input", data: "ls\n" },
      { type: "resize", cols: 120, rows: 40 },
      { type: "terminate" },
    ]) {
      expect(terminalClientMessageSchema.safeParse(message).success).toBe(true);
    }
    for (const message of [
      { type: "output", data: "hi" },
      { type: "status", status: "exited", exitCode: 7 },
      { type: "status", status: "running", exitCode: null },
      { type: "warning", message: "Terminal output skipped 3 chunks" },
    ]) {
      expect(terminalServerMessageSchema.safeParse(message).success).toBe(true);
    }
    expect(
      terminalServerMessageSchema.safeParse({ type: "status", status: "wat" })
        .success,
    ).toBe(false);
  });

  it("models every workspace event", () => {
    const events = [
      {
        type: "agent.status",
        status: {
          nodeId: uuid,
          workspaceId: otherUuid,
          agentId: "claude",
          state: "working",
          unread: false,
          verified: true,
          restored: false,
          updatedAt: timestamp,
        },
      },
      {
        type: "agent.subagent",
        event: {
          nodeId: uuid,
          agentId: "claude",
          kind: "subagent-start",
          subagentType: "explore",
          taskLabel: "find the bug",
        },
      },
      {
        type: "agent.approval",
        nodeId: uuid,
        pendingId: "p-1",
        request: { tool: "Bash" },
      },
      {
        type: "agent.delivery",
        traceId: "t-1",
        sourceNodeId: uuid,
        targetNodeId: otherUuid,
        outcome: "delivered",
      },
      {
        type: "terminal.exit",
        sessionId: uuid,
        nodeId: otherUuid,
        exitCode: 0,
      },
      { type: "board.changed", boardId: otherUuid, updatedAt: timestamp },
    ];
    for (const event of events) {
      const parsed = workspaceEventSchema.safeParse(event);
      expect(parsed.success, JSON.stringify(event.type)).toBe(true);
    }
    expect(workspaceEventSchema.safeParse({ type: "acp.update" }).success).toBe(
      false,
    );
  });

  it("writes files with content versions and literal paths", () => {
    expect(
      writeFileRequestSchema.parse({ path: "src/a.ts", content: "x" }),
    ).toEqual({ path: "src/a.ts", content: "x" });
    expect(
      writeFileRequestSchema.parse({
        path: "src/a.ts",
        content: "",
        expectedSize: 0,
      }).expectedSize,
    ).toBe(0);
    // An empty path or a negative size never reaches the runtime.
    expect(
      writeFileRequestSchema.safeParse({ path: "", content: "" }).success,
    ).toBe(false);
    expect(
      writeFileRequestSchema.safeParse({
        path: "a",
        content: "",
        expectedSize: -1,
      }).success,
    ).toBe(false);
    const sha256 = "a".repeat(64);
    expect(
      writeFileRequestSchema.parse({
        path: "  ",
        content: "",
        expectedSha256: sha256,
      }),
    ).toEqual({ path: "  ", content: "", expectedSha256: sha256 });
    expect(
      writeFileRequestSchema.safeParse({
        path: "a",
        content: "",
        expectedSha256: "bad",
      }).success,
    ).toBe(false);
    expect(
      writeFileResponseSchema.parse({ path: "a", size: 3, sha256 }).sha256,
    ).toBe(sha256);
    expect(
      writeFileResponseSchema.safeParse({ path: "a", size: 3 }).success,
    ).toBe(false);
  });

  it("reads per-file git status, and tolerates a runtime without it", () => {
    const status = gitStatusSchema.parse({
      repository: true,
      branch: "main",
      changedCount: 2,
      files: [
        { path: "a.ts", status: "M", staged: false, unstaged: true },
        { path: "b.ts", status: "A", staged: true, unstaged: false },
      ],
    });
    expect(status.files.map((file) => file.staged)).toEqual([false, true]);
    // Older runtimes omit `files` entirely rather than throwing on every poll.
    expect(
      gitStatusSchema.parse({ repository: true, branch: null, changedCount: 0 })
        .files,
    ).toEqual([]);
    expect(
      gitStatusSchema.safeParse({
        repository: true,
        branch: "main",
        changedCount: 1,
        files: [{ path: "a.ts", status: "X", staged: true, unstaged: false }],
      }).success,
    ).toBe(false);
  });

  it("defaults a diff request to the worktree scope", () => {
    expect(gitDiffRequestSchema.parse({})).toEqual({ scope: "worktree" });
    expect(
      gitDiffRequestSchema.parse({ scope: "staged", paths: ["a.ts"] }),
    ).toEqual({ scope: "staged", paths: ["a.ts"] });
    expect(gitDiffRequestSchema.safeParse({ scope: "index" }).success).toBe(
      false,
    );
    // `staged` defaults to false so an older runtime's diff still parses.
    expect(
      gitFileDiffSchema.parse({
        path: "a.ts",
        status: "M",
        additions: 1,
        deletions: 0,
        patch: "",
      }).staged,
    ).toBe(false);
  });

  it("types the unstage response and the hook install report", () => {
    expect(
      gitUnstageResponseSchema.parse({ unstaged: ["a.ts"] }).unstaged,
    ).toEqual(["a.ts"]);
    const report = hookInstallReportSchema.parse({
      agentId: "claude",
      configPath: "/home/u/.claude/settings.json",
      clientRevision: 2,
      installed: true,
      extraKeyFromANewerRuntime: 1,
    });
    expect(report.installed).toBe(true);
    expect(report.warning).toBeUndefined();
  });
});

describe("conversations and AI naming (plan §17)", () => {
  it("types a conversation row without exposing the transcript path", () => {
    const [row] = conversationsResponseSchema.parse([
      {
        provider: "codex",
        sessionId: "019edf45-4c81-7d30-a950-9d7a7cc853c7",
        title: "对比两种实现方式",
        cwd: "/Users/me/repo",
        updatedAt: "2026-09-04T02:06:15.000Z",
        bytes: 802832,
      },
    ]);
    expect(row!.provider).toBe("codex");
    expect(row!.title).toBe("对比两种实现方式");
    expect(row).not.toHaveProperty("path");

    // Gemini records no working directory, so an empty string is legal.
    expect(
      conversationsResponseSchema.safeParse([
        {
          provider: "gemini",
          sessionId: "s",
          title: "t",
          cwd: "",
          updatedAt: "2026-09-04T02:06:15.000Z",
          bytes: 0,
        },
      ]).success,
    ).toBe(true);

    // opencode has no readable transcript store, so it is not a provider here.
    expect(
      conversationsResponseSchema.safeParse([
        {
          provider: "opencode",
          sessionId: "s",
          title: "t",
          cwd: "",
          updatedAt: "2026-09-04T02:06:15.000Z",
          bytes: 0,
        },
      ]).success,
    ).toBe(false);
  });

  it("types the rescan report and the suggested title", () => {
    const report = conversationRefreshResponseSchema.parse({
      scanned: 2344,
      indexed: 12,
      removed: 0,
      total: 2340,
    });
    expect(report.indexed).toBe(12);

    expect(
      suggestTitleResponseSchema.parse({
        title: "给终端节点加上 AI 命名",
        source: "transcript",
      }).source,
    ).toBe("transcript");
    // Forty characters is the header's budget.
    expect(
      suggestTitleResponseSchema.safeParse({
        title: "x".repeat(41),
        source: "terminal",
      }).success,
    ).toBe(false);
    expect(
      suggestTitleResponseSchema.safeParse({ title: "x", source: "model" })
        .success,
    ).toBe(false);
  });

  it("rejects retired board writes, including null, without silently stripping them", () => {
    const value = {
      expectedUpdatedAt: "2026-09-04T02:06:15.000Z",
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    expect(saveBoardRequestSchema.safeParse(value).success).toBe(true);
    expect(
      saveBoardRequestSchema.safeParse({
        ...value,
        kanban: { columns: [], cards: {} },
      }).success,
    ).toBe(false);
    expect(
      saveBoardRequestSchema.safeParse({ ...value, kanban: null }).success,
    ).toBe(false);
  });
});
