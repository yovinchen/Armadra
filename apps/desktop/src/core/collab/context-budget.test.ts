import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { rfc3339, uuidV7 } from "../workspaces/support";
import { listContextReads } from "./context-reads";
import { runContextLink } from "./context-link";
import { Args, Refusal, Refused } from "./refusals";

/**
 * 阶段 C+：上下文读取预算（设计 `agent-delivery.md` §13）。
 *
 * 与 `context-link.test.ts` 分开一个文件，因为守的是不同的东西：那一份守的是
 * 授权（谁能读谁、读到的是什么类型的内容），这一份守的是**代价**——一次读取
 * 有多大、第二次读还给不给同样的东西、密钥会不会跟着过来。
 */

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

function node(type: string, title: string, data: unknown): string {
  const id = uuidV7();
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

function say(role: "user" | "assistant", text: string): unknown {
  return { type: role, message: { role, content: text } };
}

function transcriptFile(path: string, entries: readonly unknown[]): void {
  writeFileSync(
    path,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}

/** 一个连着调用者、有转录的 Agent 节点。 */
function peerWithTranscript(entries: readonly unknown[]): {
  id: string;
  path: string;
} {
  const peer = fixture.agentNode("Peer");
  fixture.link(me, peer);
  const path = join(fixture.directory, "peer.jsonl");
  transcriptFile(path, entries);
  statusRow(peer, path);
  return { id: peer, path };
}

beforeEach(() => {
  fixture = agentFixture();
  me = fixture.agentNode("Caller");
});

afterEach(() => {
  fixture.close();
});

describe("摘要", () => {
  it("不再接受 -n：给了也只回一份常数大小的摘要", async () => {
    peerWithTranscript([
      say("user", "第一件"),
      say("assistant", "好"),
      say("user", "第二件"),
      say("assistant", "做完了"),
    ]);
    const body = await read(me, "summary", { node: "Peer", n: 400 });
    expect(body).toContain("最后一条人类提示：第二件");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(2 * 1024);
  });

  it("说出对方的名字与五态", async () => {
    const peer = peerWithTranscript([say("user", "在做")]);
    fixture.name(peer.id, "codex-1");
    const body = await read(me, "summary", { node: "codex-1" });
    expect(body).toContain("名字=codex-1");
    expect(body).toContain("状态：");
  });

  it("有待审批时头一行说出来", async () => {
    const peer = peerWithTranscript([say("user", "在做")]);
    fixture.database
      .prepare(
        "INSERT INTO agent_approvals (id, node_id, workspace_id, request_json, created_at, revision) " +
          "VALUES (?, ?, ?, '{}', ?, 0)",
      )
      .run("pending-1", peer.id, fixture.workspaceId, rfc3339());
    expect(await read(me, "summary", { node: "Peer" })).toContain("待审批");
  });

  it("列出这一轮碰过的文件", async () => {
    peerWithTranscript([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/x/a.ts" } },
          ],
        },
      },
    ]);
    const body = await read(me, "summary", { node: "Peer" });
    expect(body).toContain("/x/a.ts");
    expect(body).toContain("工具调用 1 次");
  });
});

describe("原文读取", () => {
  it("默认只给最近 20 条", async () => {
    peerWithTranscript(
      Array.from({ length: 50 }, (_value, index) =>
        say("user", `第${index}条`),
      ),
    );
    const body = await read(me, "transcript", { node: "Peer" });
    expect(body).toContain("最近的 20 条");
    expect(body).toContain("第49条");
    expect(body).not.toContain("第29条");
  });

  it("tool_result 只留工具名、字节数与首行", async () => {
    peerWithTranscript([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: `README.md\n${"x".repeat(50_000)}`,
            },
          ],
        },
      },
    ]);
    const body = await read(me, "transcript", { node: "Peer" });
    expect(body).toContain("[结果 Bash");
    expect(body).toContain("首行：README.md");
    expect(body).not.toContain("x".repeat(200));
  });

  it("单次总量收在 32 KB 那一档", async () => {
    peerWithTranscript(
      Array.from({ length: 40 }, () => say("assistant", "啊".repeat(3_000))),
    );
    const body = await read(me, "transcript", { node: "Peer" });
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(34 * 1024);
    expect(body).toContain("到上限就停了");
  });

  it("--full --max-kb 能抬高上限，但抬不过 128 KB", async () => {
    peerWithTranscript(
      Array.from({ length: 60 }, () => say("assistant", "b".repeat(4_000))),
    );
    const body = await read(me, "transcript", {
      node: "Peer",
      full: true,
      "max-kb": 900,
      n: 60,
    });
    expect(body).toContain("--full");
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(130 * 1024);
  });

  it("头部报出这次约值多少 token", async () => {
    peerWithTranscript([say("user", "x".repeat(350))]);
    expect(await read(me, "transcript", { node: "Peer" })).toMatch(
      /≈ \d+ token/,
    );
  });
});

describe("增量游标", () => {
  it("--since 只回上次之后的新条目", async () => {
    const peer = peerWithTranscript([say("user", "第一轮")]);
    await read(me, "transcript", { node: "Peer" });
    appendFileSync(peer.path, `${JSON.stringify(say("user", "第二轮"))}\n`);
    const body = await read(me, "transcript", { node: "Peer", since: true });
    expect(body).toContain("第二轮");
    expect(body).not.toContain("第一轮");
  });

  it("没有新条目时说清楚，而不是把整份再给一遍", async () => {
    peerWithTranscript([say("user", "只有这一条")]);
    await read(me, "transcript", { node: "Peer" });
    const body = await read(me, "transcript", { node: "Peer", since: true });
    expect(body).toContain("没有新条目");
  });

  it("换了转录文件就从头读", async () => {
    const peer = peerWithTranscript([say("user", "旧会话")]);
    await read(me, "transcript", { node: "Peer" });
    const next = join(fixture.directory, "next.jsonl");
    transcriptFile(next, [say("user", "新会话")]);
    fixture.database
      .prepare("UPDATE agent_status SET transcript_path = ? WHERE node_id = ?")
      .run(next, peer.id);
    const body = await read(me, "transcript", { node: "Peer", since: true });
    expect(body).toContain("新会话");
  });

  it("回复末尾打印游标", async () => {
    peerWithTranscript([say("user", "一条")]);
    expect(await read(me, "transcript", { node: "Peer" })).toContain("游标：");
  });
});

describe("读取预算", () => {
  it("同一条连线读到超额时回 RATE_LIMITED", async () => {
    peerWithTranscript(
      Array.from({ length: 30 }, () => say("assistant", "字".repeat(1_500))),
    );
    let refused: unknown;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await read(me, "transcript", { node: "Peer", n: 30 });
      } catch (error) {
        refused = error;
        break;
      }
    }
    expect(refused).toBeInstanceOf(Refused);
    const error = refused as Refused;
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.status).toBe(429);
    expect(error.message).toContain("summary");
    expect(error.message).toContain("--since");
  });

  it("每次读取写一行审计", async () => {
    const peer = peerWithTranscript([say("user", "一条")]);
    await read(me, "summary", { node: "Peer" });
    await read(me, "transcript", { node: "Peer" });
    const page = listContextReads(fixture.database, peer.id, 10);
    expect(page.total).toBe(2);
    expect(page.reads.map((entry) => entry.verb).sort()).toEqual([
      "summary",
      "transcript",
    ]);
    expect(page.bytes).toBeGreaterThan(0);
  });
});

describe("脱敏", () => {
  it("转录里的密钥换成 [已脱敏]", async () => {
    peerWithTranscript([
      say("user", "用 ghp_0123456789abcdefghijklmnopqrstuvwxyz 推上去"),
    ]);
    const body = await read(me, "transcript", { node: "Peer" });
    expect(body).not.toContain("ghp_0123456789");
    expect(body).toContain("[已脱敏]");
  });

  it("终端画面过脱敏，并且去掉转义序列", async () => {
    const peer = fixture.agentNode("Peer");
    fixture.link(me, peer);
    fixture.session(peer, "claude");
    fixture.terminal.capture =
      "\u001b[2K\u001b[G$ echo $OPENAI_API_KEY\nsk-abcdefghijklmnopqrstuvwxyz0123\n";
    const body = await read(me, "terminal", { node: "Peer" });
    expect(body).not.toContain("\u001b");
    expect(body).not.toContain("[2K");
    expect(body).not.toContain("sk-abcdefghijklmnop");
    expect(body).toContain("[已脱敏]");
  });

  it("文件内容也过脱敏", async () => {
    writeFileSync(
      join(fixture.directory, "secret.env"),
      "CLIENT_SECRET=0123456789abcdefghij\n",
    );
    const editor = node("editor", "Env", {
      kind: "editor",
      path: "secret.env",
    });
    fixture.link(me, editor);
    const body = await read(me, "summary", { node: "Env" });
    expect(body).not.toContain("0123456789abcdefghij");
    expect(body).toContain("[已脱敏]");
  });
});

describe("节点级开关", () => {
  function summaryOnlyPeer(): string {
    const id = node("terminal", "Closed", {
      kind: "terminal",
      agent: { id: "claude", contextShare: "summary" },
    });
    fixture.link(me, id);
    return id;
  }

  it("摘要照读", async () => {
    const peer = summaryOnlyPeer();
    const path = join(fixture.directory, "closed.jsonl");
    transcriptFile(path, [say("user", "在做一件事")]);
    statusRow(peer, path);
    expect(await read(me, "summary", { node: "Closed" })).toContain(
      "在做一件事",
    );
  });

  it("转录原文被拒，并说清楚该用什么", async () => {
    summaryOnlyPeer();
    const refused = await refusalOf(me, "transcript", { node: "Closed" });
    expect(refused.status).toBe(403);
    expect(refused.message).toContain("只对外开放摘要");
    expect(refused.message).toContain("context summary");
  });

  it("终端画面被拒", async () => {
    summaryOnlyPeer();
    expect((await refusalOf(me, "terminal", { node: "Closed" })).status).toBe(
      403,
    );
  });

  it("内容节点关掉之后连文件都不给", async () => {
    writeFileSync(join(fixture.directory, "shut.txt"), "内容");
    const id = node("editor", "Shut", {
      kind: "editor",
      path: "shut.txt",
      agent: { id: "claude", contextShare: "summary" },
    });
    fixture.link(me, id);
    expect((await refusalOf(me, "summary", { node: "Shut" })).status).toBe(403);
  });

  it("缺省是 full：0025 之前的节点一个都不受影响", async () => {
    peerWithTranscript([say("user", "照读")]);
    expect(await read(me, "transcript", { node: "Peer" })).toContain("照读");
  });
});

describe("终端画面", () => {
  it("上限从 400 收到 200 行", async () => {
    const peer = fixture.agentNode("Peer");
    fixture.link(me, peer);
    fixture.session(peer, "claude");
    fixture.terminal.capture = "$ ls\n";
    const body = await read(me, "terminal", { node: "Peer", n: 4_000 });
    expect(body).toContain("最近 200 行");
  });

  it("默认仍是 40 行", async () => {
    const peer = fixture.agentNode("Peer");
    fixture.link(me, peer);
    fixture.session(peer, "claude");
    fixture.terminal.capture = "$ ls\n";
    expect(await read(me, "terminal", { node: "Peer" })).toContain(
      "最近 40 行",
    );
  });
});

describe("被读取 N 次的 JSON 面", () => {
  it("GET /api/nodes/{id}/context-reads 给总数与最近几条", async () => {
    const peer = peerWithTranscript([say("user", "一条")]);
    await read(me, "summary", { node: "Peer" });
    const answer = await fixture.call(
      "GET",
      `/api/nodes/${peer.id}/context-reads`,
    );
    expect(answer.status).toBe(200);
    const body = answer.body as {
      total: number;
      bytes: number;
      reads: { readerNodeId: string; verb: string }[];
    };
    expect(body.total).toBe(1);
    expect(body.bytes).toBeGreaterThan(0);
    expect(body.reads[0]?.readerNodeId).toBe(me);
    expect(body.reads[0]?.verb).toBe("summary");
  });

  it("没被读过的节点给一份空清单，而不是 404", async () => {
    const answer = await fixture.call("GET", `/api/nodes/${me}/context-reads`);
    expect(answer.status).toBe(200);
    expect((answer.body as { total: number }).total).toBe(0);
  });

  it("limit 再大也只给上限那么多", async () => {
    const peer = peerWithTranscript([say("user", "一条")]);
    await read(me, "summary", { node: "Peer" });
    const answer = await fixture.call(
      "GET",
      `/api/nodes/${peer.id}/context-reads?limit=9999`,
    );
    expect(answer.status).toBe(200);
    expect((answer.body as { reads: unknown[] }).reads.length).toBe(1);
  });
});
