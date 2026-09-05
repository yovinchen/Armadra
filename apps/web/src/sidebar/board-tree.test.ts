import { describe, expect, it } from "vitest";

import type { SessionRow } from "../agent/sessions";
import {
  BOARD_PAGE_SIZE,
  boardSignals,
  nextBoardName,
  pinnedEntries,
  visibleBoards,
  type BoardEntry,
} from "./board-tree";

const timestamp = "2026-09-04T10:00:00.000Z";

function row(partial: Partial<SessionRow> & { nodeId: string }): SessionRow {
  return {
    boardId: "b1",
    sessionId: `s-${partial.nodeId}`,
    title: partial.nodeId,
    cwd: "/repo",
    unread: false,
    updatedAt: timestamp,
    alive: true,
    sinceMs: 0,
    ...partial,
  };
}

function board(id: string, name = id): BoardEntry {
  return { id, name, nodeCount: 0 };
}

const attention = (item: SessionRow) =>
  item.state === "blocked" || item.state === "waiting" ||
  Boolean(item.pendingId);

describe("boardSignals", () => {
  it("板内任一 Agent 命中即算命中，已结束的会话不算", () => {
    const signals = boardSignals(
      [
        row({ nodeId: "a" }),
        row({ nodeId: "b", unread: true }),
        row({ nodeId: "c", boardId: "b2", state: "blocked" }),
        row({ nodeId: "d", boardId: "b3", unread: true, alive: false }),
      ],
      attention,
    );

    expect(signals.b1).toEqual({ attention: false, unread: true });
    expect(signals.b2).toEqual({ attention: true, unread: false });
    expect(signals.b3).toBeUndefined();
  });
});

describe("visibleBoards", () => {
  const many = Array.from({ length: 12 }, (_value, index) =>
    board(`b${index}`),
  );

  it("不超过一页就全给", () => {
    const few = many.slice(0, BOARD_PAGE_SIZE);
    expect(visibleBoards(few, false, null)).toHaveLength(BOARD_PAGE_SIZE);
  });

  it("收起时只留一页", () => {
    expect(visibleBoards(many, false, null)).toHaveLength(BOARD_PAGE_SIZE);
    expect(visibleBoards(many, true, null)).toHaveLength(12);
  });

  it("当前那块板一定看得见", () => {
    const visible = visibleBoards(many, false, "b11");
    expect(visible).toHaveLength(BOARD_PAGE_SIZE);
    expect(visible.at(-1)?.id).toBe("b11");
  });
});

describe("pinnedEntries", () => {
  it("按偏好里的顺序返回，找不到的 id 跳过", () => {
    const entries = pinnedEntries(
      ["b2", "missing", "b1"],
      [
        { id: "w1", name: "repo", boards: [board("b1")] },
        { id: "w2", name: "other", boards: [board("b2")] },
      ],
    );

    expect(entries.map((entry) => entry.board.id)).toEqual(["b2", "b1"]);
    expect(entries[0]?.workspaceName).toBe("other");
  });
});

describe("nextBoardName", () => {
  it("接着编号，避开同名", () => {
    const template = (index: number) => `看板 ${index}`;
    expect(nextBoardName([board("a"), board("b")], template)).toBe("看板 3");
    expect(
      nextBoardName(
        [board("a"), board("b", "看板 4"), board("c")],
        template,
      ),
    ).toBe("看板 5");
  });
});
