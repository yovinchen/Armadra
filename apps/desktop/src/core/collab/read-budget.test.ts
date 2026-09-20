import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import {
  listContextReads,
  noteRead,
  readCursor,
  writeCursor,
} from "./context-reads";
import {
  READ_BUDGET_HOUR_BYTES,
  READ_BUDGET_MINUTE_BYTES,
  checkReadBudget,
  requireReadBudget,
} from "./read-budget";
import { Refused } from "./refusals";

let fixture: AgentFixture;
let reader: string;
let target: string;

const NOW = 1_800_000_000_000;

beforeEach(() => {
  fixture = agentFixture();
  reader = fixture.agentNode("Reader");
  target = fixture.agentNode("Target");
});

afterEach(() => {
  fixture.close();
});

function spend(bytes: number, atMs: number): void {
  noteRead(
    fixture.database,
    { reader, target, verb: "transcript", bytes },
    atMs,
  );
}

describe("读取预算", () => {
  it("没读过的时候放行", () => {
    expect(checkReadBudget(fixture.database, reader, target, NOW).allowed).toBe(
      true,
    );
  });

  it("每分钟的额度花完就拒，并说得出还要等多久", () => {
    spend(READ_BUDGET_MINUTE_BYTES, NOW - 10_000);
    const verdict = checkReadBudget(fixture.database, reader, target, NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.window).toBe("minute");
    expect(verdict.retryAfterMs).toBeGreaterThan(0);
    expect(verdict.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("分钟窗口滑过去之后又能读", () => {
    spend(READ_BUDGET_MINUTE_BYTES, NOW - 61_000);
    expect(checkReadBudget(fixture.database, reader, target, NOW).allowed).toBe(
      true,
    );
  });

  it("小时的额度独立于分钟，攒够了照样拒", () => {
    // 每分钟一笔，各自不超分钟额度，但一小时加起来超过 1 MB。
    let at = NOW - 3_500_000;
    while (at < NOW - 70_000) {
      spend(60 * 1024, at);
      at += 60_000;
    }
    const verdict = checkReadBudget(fixture.database, reader, target, NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.window).toBe("hour");
    expect(verdict.spent).toBeGreaterThanOrEqual(READ_BUDGET_HOUR_BYTES);
  });

  /** 三个 Agent 各读一次是协作；一个 Agent 读三十次不是。 */
  it("额度按「读者 → 目标」这一对算，别人的读不占我的", () => {
    const other = fixture.agentNode("Other");
    noteRead(
      fixture.database,
      { reader: other, target, verb: "transcript", bytes: READ_BUDGET_MINUTE_BYTES },
      NOW - 1_000,
    );
    expect(checkReadBudget(fixture.database, reader, target, NOW).allowed).toBe(
      true,
    );
  });

  it("超额时抛 RATE_LIMITED(429)，并指出 summary 与 --since", () => {
    spend(READ_BUDGET_MINUTE_BYTES, NOW - 1_000);
    let error: unknown;
    try {
      requireReadBudget(fixture.database, reader, target, "Target", NOW);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(Refused);
    const refused = error as Refused;
    expect(refused.code).toBe("RATE_LIMITED");
    expect(refused.status).toBe(429);
    expect(refused.message).toContain("summary");
    expect(refused.message).toContain("--since");
    expect(refused.detail?.retryAfterMs).toBeGreaterThan(0);
  });

  it("额度没花完时一声不吭地通过", () => {
    spend(1_024, NOW - 1_000);
    expect(() =>
      requireReadBudget(fixture.database, reader, target, "Target", NOW),
    ).not.toThrow();
  });
});

describe("游标", () => {
  it("第一次读没有游标", () => {
    expect(
      readCursor(fixture.database, reader, target, "/tmp/a.jsonl"),
    ).toBeUndefined();
  });

  it("记下之后读得回来", () => {
    writeCursor(
      fixture.database,
      reader,
      target,
      { transcriptPath: "/tmp/a.jsonl", byteOffset: 4_096 },
      NOW,
    );
    const cursor = readCursor(fixture.database, reader, target, "/tmp/a.jsonl");
    expect(cursor?.byteOffset).toBe(4_096);
    expect(cursor?.updatedAtMs).toBe(NOW);
  });

  /** 换了文件就是换了会话：那个偏移在新文件里指的是另一段话。 */
  it("文件换了就当没读过", () => {
    writeCursor(
      fixture.database,
      reader,
      target,
      { transcriptPath: "/tmp/a.jsonl", byteOffset: 4_096 },
      NOW,
    );
    expect(
      readCursor(fixture.database, reader, target, "/tmp/b.jsonl"),
    ).toBeUndefined();
  });

  it("同一对读者/目标只有一行，后写的覆盖前面的", () => {
    writeCursor(
      fixture.database,
      reader,
      target,
      { transcriptPath: "/tmp/a.jsonl", byteOffset: 1 },
      NOW,
    );
    writeCursor(
      fixture.database,
      reader,
      target,
      { transcriptPath: "/tmp/a.jsonl", byteOffset: 9 },
      NOW + 1,
    );
    expect(
      readCursor(fixture.database, reader, target, "/tmp/a.jsonl")?.byteOffset,
    ).toBe(9);
  });
});

describe("审计", () => {
  it("数出被读过几次、读走多少字节，新的在前", () => {
    spend(100, NOW - 2_000);
    spend(200, NOW - 1_000);
    const page = listContextReads(fixture.database, target, 10);
    expect(page.total).toBe(2);
    expect(page.bytes).toBe(300);
    expect(page.reads[0]?.bytes).toBe(200);
    expect(page.reads[0]?.readerNodeId).toBe(reader);
  });

  it("带上读者的名字与标题，页面不用再查一次", () => {
    fixture.name(reader, "planner");
    spend(10, NOW);
    const page = listContextReads(fixture.database, target, 10);
    expect(page.reads[0]?.readerHandle).toBe("planner");
    expect(page.reads[0]?.readerTitle).toBe("Reader");
  });

  it("limit 说了算", () => {
    for (let index = 0; index < 5; index += 1) spend(10, NOW + index);
    expect(listContextReads(fixture.database, target, 2).reads.length).toBe(2);
    expect(listContextReads(fixture.database, target, 2).total).toBe(5);
  });

  it("没被读过的节点是一份空清单", () => {
    const page = listContextReads(fixture.database, reader, 10);
    expect(page.total).toBe(0);
    expect(page.reads).toEqual([]);
  });
});
