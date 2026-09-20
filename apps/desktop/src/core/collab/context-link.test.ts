import { mkdirSync, writeFileSync } from "node:fs";
import { createBoard } from "../canvas/boards";
import { createWorkspace } from "../workspaces/table";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { putContextLinks } from "../canvas/context-links";
import { rfc3339 } from "../workspaces/support";
import { readableAs, runContextLink } from "./context-link";
import { Args, Refusal } from "./refusals";

/** Ported from the pre-merge implementation. */

let fixture: AgentFixture;
let me: string;

async function read(
  nodeId: string,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  return runContextLink(
    fixture.collab,
    callerFor(fixture, nodeId),
    verb,
    new Args(args),
  );
}

async function refusalOf(
  nodeId: string,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<Refusal> {
  try {
    await read(nodeId, verb, args);
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

function statusRow(nodeId: string, transcriptPath: string): void {
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, updated_at, transcript_path) " +
        "VALUES (?, ?, 'claude', 'idle', 0, 1, 0, ?, ?)",
    )
    .run(nodeId, fixture.workspaceId, rfc3339(), transcriptPath);
}

beforeEach(() => {
  fixture = agentFixture();
  me = fixture.agentNode("Caller");
});

afterEach(() => {
  fixture.close();
});

describe("list", () => {
  it("says how to draw a link when there is none", async () => {
    const body = await read(me, "list");
    expect(body).toContain("还没有连接任何其他节点");
  });

  it("names every link, its kind and what it can be read as", async () => {
    const note = fixture.stickyNode("Note", "hello");
    fixture.link(me, note);
    const body = await read(me, "list");
    expect(body).toContain("已连接 1 个节点");
    expect(body).toContain("Note");
    expect(body).toContain(readableAs("sticky"));
    expect(body).toContain("armadra-hook context summary");
  });

  /**
   * `list` 是 Agent 唯一一处「我连着谁、各自叫什么」的答案（设计 §2.3）。没有
   * 它，一个被告知「把结果交给 reviewer」的模型只能猜哪个 id 是 reviewer。
   */
  it("carries each peer's name, and leaves the line alone when it has none", async () => {
    const peer = fixture.agentNode("Codex", "codex");
    fixture.link(me, peer);
    // 没起名的那些行一个字都不多：名字是给协作用的，一块只有一个 Agent 的
    // 画布不需要它。
    expect(await read(me, "list")).not.toContain("名字=");
    fixture.name(peer, "reviewer");
    expect(await read(me, "list")).toContain("名字=reviewer");
  });

  it("labels a whiteboard reference and reports its export state", async () => {
    putContextLinks(fixture.database, fixture.workspaceId, me, [
      {
        id: "018f0000-0000-7000-8000-000000000001",
        title: "Sketch",
        kind: "shape",
        content: { status: "pending" },
      },
    ]);
    const body = await read(me, "list");
    expect(body).toContain("类型=白板内容");
    expect(body).toContain("图片准备中");
  });
});

describe("reading a linked node", () => {
  it("refuses an unknown verb by name", async () => {
    const refused = await refusalOf(me, "explode");
    expect(refused.status).toBe(400);
    expect(refused.message).toContain("explode");
  });

  it("reads a sticky's body whatever verb is asked for", async () => {
    const note = fixture.stickyNode("Note", "the plan");
    fixture.link(me, note);
    for (const verb of ["summary", "transcript", "terminal"]) {
      expect(await read(me, verb, { node: "Note" })).toContain("the plan");
    }
    expect(await read(me, "summary", { node: "Note" })).toContain(
      "便签「Note」",
    );
  });

  it("says a sticky is empty rather than answering with nothing", async () => {
    const note = fixture.stickyNode("Note", "   ");
    fixture.link(me, note);
    expect(await read(me, "summary", { node: "Note" })).toContain("还是空的");
  });

  it("reads an editor node's file, resolved inside the workspace", async () => {
    writeFileSync(join(fixture.directory, "a.txt"), "file body\n");
    const editor = editorNode("Editor", "a.txt");
    fixture.link(me, editor);
    expect(await read(me, "summary", { node: "Editor" })).toContain(
      "file body",
    );
  });

  it("never lets a doctored path escape the workspace", async () => {
    const editor = editorNode("Escape", "../../etc/passwd");
    fixture.link(me, editor);
    const refused = await refusalOf(me, "summary", { node: "Escape" });
    expect(refused.status).toBe(404);
  });

  it("refuses a binary file instead of rendering mojibake", async () => {
    writeFileSync(join(fixture.directory, "b.bin"), Buffer.from([1, 0, 2, 0]));
    const editor = editorNode("Binary", "b.bin");
    fixture.link(me, editor);
    const refused = await refusalOf(me, "summary", { node: "Binary" });
    expect(refused.status).toBe(400);
    expect(refused.message).toContain("二进制");
  });

  it("lists a files node's directory", async () => {
    mkdirSync(join(fixture.directory, "sub"), { recursive: true });
    writeFileSync(join(fixture.directory, "sub", "one.txt"), "x");
    const files = node("files", "Files", { kind: "files", path: "sub" });
    fixture.link(me, files);
    const body = await read(me, "summary", { node: "Files" });
    expect(body).toContain("one.txt");
    expect(body).toContain("共 1 项");
  });

  it("gives a browser node's address, or says it has none", async () => {
    const browser = node("browser", "Web", {
      kind: "browser",
      url: "https://example.com",
    });
    fixture.link(me, browser);
    expect(await read(me, "summary", { node: "Web" })).toContain(
      "https://example.com",
    );
  });

  it("renders a linked agent's transcript, newest last", async () => {
    const peer = fixture.agentNode("Peer");
    fixture.link(me, peer);
    const path = join(fixture.directory, "transcript.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", message: { content: "do the thing" } }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "done" }] },
        }),
        "not json",
      ].join("\n"),
    );
    statusRow(peer, path);
    const body = await read(me, "transcript", { node: "Peer" });
    expect(body).toContain("[用户] do the thing");
    expect(body).toContain("[助手] done");
    expect(body).toContain("完整转录 2 条");
    // `summary` is the same reader with a line budget.
    const summary = await read(me, "summary", { node: "Peer", n: 1 });
    expect(summary).toContain("最近 1 条（共 2 条");
    expect(summary).not.toContain("[用户]");
  });

  it("says where the transcript would be rather than answering empty", async () => {
    const peer = fixture.agentNode("Peer");
    fixture.link(me, peer);
    const refused = await refusalOf(me, "transcript", { node: "Peer" });
    expect(refused.status).toBe(404);
    expect(refused.message).toContain("terminal");
  });

  it("reads a peer's terminal screen", async () => {
    const peer = fixture.agentNode("Peer");
    fixture.link(me, peer);
    fixture.session(peer, "claude");
    fixture.terminal.capture = "$ ls\nREADME.md\n";
    const body = await read(me, "terminal", { node: "Peer", n: 5 });
    expect(body).toContain("README.md");
    expect(body).toContain("终端最近 5 行");
  });

  it("refuses a link that points out of the workspace", async () => {
    // The link document is per node, not per workspace; one that outlived a
    // board move must not become a cross-workspace read.
    const peer = fixture.agentNode("Peer");
    fixture.link(me, peer);
    mkdirSync(join(fixture.directory, "elsewhere"), { recursive: true });
    const elsewhere = createWorkspace(fixture.database, {
      name: "elsewhere",
      rootPath: join(fixture.directory, "elsewhere"),
    });
    const board = createBoard(fixture.database, elsewhere.id, "Other");
    fixture.database
      .prepare("UPDATE nodes SET board_id = ? WHERE id = ?")
      .run(board.id, peer);
    const refused = await refusalOf(me, "summary", { node: "Peer" });
    expect(refused.status).toBe(403);
    expect(refused.message).toContain("不在当前工作空间");
  });

  it("refuses when a custom agent has context links switched off", async () => {
    const custom = fixture.agentNode("Custom", "custom:narrow");
    fixture.customAgents.push({
      id: "custom:narrow",
      label: "Narrow",
      color: "#ffffff",
      launchCmd: "wrapper",
      args: [],
      env: {},
      baseAgent: "claude",
      disabledCapabilities: ["contextLink"],
    });
    const refused = await refusalOf(custom, "list");
    expect(refused.status).toBe(403);
  });
});

function node(type: string, title: string, data: unknown): string {
  const id = crypto.randomUUID();
  const now = rfc3339();
  fixture.database
    .prepare(
      "INSERT INTO nodes (id, board_id, type, title, color, x, y, width, height, " +
        "labels_json, note, data_json, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, '#0a84ff', 0, 0, 240, 200, '[]', '', ?, ?, ?)",
    )
    .run(id, fixture.boardId, type, title, JSON.stringify(data), now, now);
  return id;
}

function editorNode(title: string, path: string): string {
  return node("editor", title, { kind: "editor", path });
}
