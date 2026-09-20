import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { getContextLinks, nodeRole } from "../canvas/context-links";
import { loadBoard } from "../canvas/documents";
import { agentEnvironment } from "../terminal/environment";
import { freeLease } from "../drive/lease";
import { controlDispatcher, type ControlOutcome } from "./control";
import { resetSendLimits } from "./send-limits";
import { resetInboxWake } from "./wake";

/**
 * 主从与对等（迁移 0024）。
 *
 * 一条边到 0023 为止只回答「有没有」，而 `send` 让「有」变得不够用了：把一段
 * 文字打进别人的终端并回车，在「我是你的主」和「我是你的下级」之间不是同一件
 * 事。这一批断言的是那条方向，以及它在三处读出来是同一个答案：边上的 `role`、
 * 两份链接文档互补的视角、模型看得见的那几行散文。
 */

let fixture: AgentFixture;
let main: string;
let sub: string;
let subSession: string;

async function run(
  nodeId: string,
  verb: string,
  args: Record<string, unknown> = {},
): Promise<ControlOutcome> {
  const dispatcher = controlDispatcher();
  if (dispatcher === undefined) throw new Error("no dispatcher");
  return dispatcher.dispatch(verb, callerFor(fixture, nodeId), args);
}

function ok(outcome: ControlOutcome): Record<string, unknown> {
  if (!outcome.ok) {
    throw new Error(`refused: ${outcome.code} ${outcome.message}`);
  }
  return outcome.body;
}

function live(nodeId: string, sessionId: string): void {
  fixture.terminal.drive.set(nodeId, {
    nodeId,
    sessionId,
    state: "idle",
    stateSource: "hook",
    lease: freeLease(0),
    driveGeneration: 0,
  } as never);
}

beforeEach(() => {
  resetSendLimits();
  resetInboxWake();
  fixture = agentFixture();
  main = fixture.agentNode("Planner");
  sub = fixture.agentNode("Codex", "codex");
  subSession = fixture.session(sub, "codex");
  fixture.name(main, "planner");
  fixture.name(sub, "codex-1");
  fixture.terminal.foreground = { command: "codex" };
  live(sub, subSession);
});

afterEach(() => {
  fixture.close();
  resetSendLimits();
  resetInboxWake();
});

describe("the link verb", () => {
  it("draws a peer edge by default and a directed one on request", async () => {
    ok(await run(main, "link", { from: main, to: sub }));
    const peer = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    ).edges.find((edge) => edge.source === main);
    expect(peer?.role).toBe("peer");
    expect(getContextLinks(fixture.database, main).links[0]?.role).toBe("peer");

    // 改一条已有边的角色也走同一个动词。
    ok(await run(main, "link", { from: main, to: sub, role: "supervises" }));
    const directed = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    ).edges.find((edge) => edge.source === main);
    expect(directed?.role).toBe("supervises");
    expect(directed?.id).toBe(peer?.id);
    // 两份链接文档是互补的两个视角，不是同一句话抄两遍。
    expect(getContextLinks(fixture.database, main).links[0]?.role).toBe("sub");
    expect(getContextLinks(fixture.database, sub).links[0]?.role).toBe("main");
  });

  it("refuses a role it does not know instead of guessing one", async () => {
    const refused = await run(main, "link", {
      from: main,
      to: sub,
      role: "boss",
    });
    expect(refused.ok).toBe(false);
  });

  it("makes the node it creates its creator's sub", async () => {
    const created = (
      ok(await run(main, "open-agent", { agent: "codex" })).result as {
        id: string;
      }
    ).id;
    const edge = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    ).edges.find((entry) => entry.target === created);
    expect(edge?.role).toBe("supervises");
    expect(edge?.source).toBe(main);
    expect(
      getContextLinks(fixture.database, created).links.find(
        (link) => link.id === main,
      )?.role,
    ).toBe("main");
  });
});

describe("which way a delivery may go", () => {
  beforeEach(async () => {
    ok(await run(main, "link", { from: main, to: sub, role: "supervises" }));
  });

  it("lets the main type into its sub", async () => {
    const body = ok(await run(main, "send", { to: sub, body: "做这件事" }));
    expect(body).toMatchObject({ outcome: "delivered" });
  });

  it("refuses the sub typing into its main, and says which way is open", async () => {
    const mainSession = fixture.session(main, "claude");
    live(main, mainSession);
    fixture.terminal.foreground = { command: "claude" };
    const refused = await run(sub, "send", { to: main, body: "换个方向" });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.code).toBe("UPWARD_SEND_REFUSED");
    expect(refused.ok === false && refused.message).toContain("canvas post");
    expect(fixture.terminal.submits).toHaveLength(0);

    // `post` 那条路一直开着：下级要说话，只是不能替上级按键。
    ok(await run(sub, "post", { to: main, key: "k1", body: "有情况" }));
  });

  it("refuses the sub interrupting its main as well", async () => {
    const mainSession = fixture.session(main, "claude");
    live(main, mainSession);
    fixture.terminal.foreground = { command: "claude" };
    const refused = await run(sub, "interrupt", { to: main });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.code).toBe("UPWARD_SEND_REFUSED");
    expect(fixture.terminal.writes).toHaveLength(0);
  });

  it("opens the upward road only when the main says so on its own node", async () => {
    const mainSession = fixture.session(main, "claude");
    live(main, mainSession);
    fixture.terminal.foreground = { command: "claude" };
    fixture.database.prepare("UPDATE nodes SET data_json = ? WHERE id = ?").run(
      JSON.stringify({
        kind: "terminal",
        agent: { id: "claude", acceptSubDelivery: true },
      }),
      main,
    );
    const body = ok(await run(sub, "send", { to: main, body: "换个方向" }));
    expect(body).toMatchObject({ outcome: "delivered" });
  });

  it("leaves peers exactly as they were", async () => {
    ok(await run(main, "link", { from: main, to: sub, role: "peer" }));
    const mainSession = fixture.session(main, "claude");
    live(main, mainSession);
    fixture.terminal.foreground = { command: "claude" };
    expect(
      ok(await run(sub, "send", { to: main, body: "对等" })),
    ).toMatchObject({ outcome: "delivered" });
  });
});

describe("what the model sees", () => {
  beforeEach(async () => {
    ok(await run(main, "link", { from: main, to: sub, role: "supervises" }));
  });

  it("writes the role into both list verbs, from each side's own view", async () => {
    expect(String(ok(await run(main, "list")).message)).toContain(
      "角色=从（你管它）",
    );
    expect(String(ok(await run(sub, "list")).message)).toContain(
      "角色=主（它管你）",
    );
  });

  it("stamps the inbox with what the sender is to the reader", async () => {
    ok(await run(main, "post", { to: sub, key: "k1", body: "做这件事" }));
    const inbox = ok(await run(sub, "inbox", {}));
    expect((inbox.messages as { fromRole: string }[])[0]?.fromRole).toBe(
      "main",
    );
  });

  it("answers the node's own position for ARMADRA_NODE_ROLE", () => {
    expect(nodeRole(fixture.database, main)).toBe("main");
    expect(nodeRole(fixture.database, sub)).toBe("sub");
    const lonely = fixture.agentNode("Alone");
    expect(nodeRole(fixture.database, lonely)).toBeUndefined();
    // 全是对等的画布上「角色」这个概念不适用，所以变量根本不注入。
    expect(
      agentEnvironment("n", "claude", "/tmp", undefined, undefined).map(
        ([key]) => key,
      ),
    ).not.toContain("ARMADRA_NODE_ROLE");
    expect(
      agentEnvironment("n", "claude", "/tmp", "codex-1", "sub"),
    ).toContainEqual(["ARMADRA_NODE_ROLE", "sub"]);
  });
});

describe("when the main goes away", () => {
  it("leaves the sub running, with the edge gone and nobody above it", async () => {
    ok(await run(main, "link", { from: main, to: sub, role: "supervises" }));
    const document = loadBoard(
      fixture.database,
      fixture.workspaceId,
      fixture.boardId,
    );
    // 主被删掉：边跟着走（`edges` 是 ON DELETE CASCADE），从的会话一动不动。
    fixture.database.prepare("DELETE FROM nodes WHERE id = ?").run(main);
    expect(
      loadBoard(fixture.database, fixture.workspaceId, fixture.boardId).edges,
    ).toHaveLength(0);
    expect(document.edges).toHaveLength(1);
    const session = fixture.database
      .prepare("SELECT status FROM terminal_sessions WHERE id = ?")
      .get(subSession) as { status: string };
    expect(session.status).toBe("running");
    // 残留的那份链接文档指向一个不存在的节点，动词照旧拒绝而不是崩。
    const refused = await run(sub, "send", { to: main, body: "还在吗" });
    expect(refused.ok).toBe(false);
  });
});
