import { describe, expect, it } from "vitest";
import type { AgentStatus, SessionSummary } from "@armadra/shared";

import {
  basename,
  filterSessions,
  groupSessionsByStatus,
  mergeSessions,
  sessionBucket,
  type SessionRow,
} from "./sessions";

const BASE = Date.parse("2026-09-04T10:00:00.000Z");
const at = (offset: number) => new Date(BASE + offset).toISOString();

function summary(
  partial: Partial<SessionSummary> & { nodeId: string },
): SessionSummary {
  return {
    boardId: "board",
    sessionId: `s-${partial.nodeId}`,
    kind: "terminal",
    title: partial.nodeId,
    cwd: "/repo",
    unread: false,
    updatedAt: at(0),
    alive: true,
    ...partial,
  };
}

function row(partial: Partial<SessionRow> & { nodeId: string }): SessionRow {
  return {
    boardId: "board",
    sessionId: "s1",
    title: partial.nodeId,
    cwd: "/repo/api",
    unread: false,
    updatedAt: at(0),
    alive: true,
    sinceMs: 0,
    ...partial,
  };
}

describe("mergeSessions", () => {
  it("prefers the status mirror when it is fresher and sorts by recency", () => {
    const statuses: Record<string, AgentStatus> = {
      a: {
        nodeId: "a",
        workspaceId: "w",
        agentId: "claude",
        state: "done",
        unread: true,
        verified: true,
        restored: false,
        updatedAt: at(5_000),
      },
    };
    const rows = mergeSessions(
      [
        summary({ nodeId: "a", state: "working", updatedAt: at(0) }),
        summary({ nodeId: "b", updatedAt: at(1_000) }),
      ],
      statuses,
      BASE + 9_000,
    );

    expect(rows.map((entry) => entry.nodeId)).toEqual(["a", "b"]);
    expect(rows[0]!.state).toBe("done");
    expect(rows[0]!.unread).toBe(true);
    expect(rows[0]!.agentId).toBe("claude");
    expect(rows[0]!.sinceMs).toBe(4_000);
    expect(rows[1]!.sinceMs).toBe(8_000);
  });

  it("keeps the summary when the mirror is older", () => {
    const rows = mergeSessions(
      [summary({ nodeId: "a", state: "working", updatedAt: at(5_000) })],
      {
        a: {
          nodeId: "a",
          workspaceId: "w",
          agentId: "claude",
          state: "done",
          unread: false,
          verified: false,
          restored: true,
          updatedAt: at(0),
        },
      },
      BASE + 5_000,
    );
    expect(rows[0]!.state).toBe("working");
  });
});

describe("sessionBucket", () => {
  it("ranks attention over unread over working", () => {
    expect(sessionBucket(row({ nodeId: "a", state: "blocked" }))).toBe(
      "attention",
    );
    expect(sessionBucket(row({ nodeId: "a", state: "waiting" }))).toBe(
      "attention",
    );
    expect(
      sessionBucket(row({ nodeId: "a", state: "done", pendingId: "p" })),
    ).toBe("attention");
    expect(
      sessionBucket(row({ nodeId: "a", state: "done", unread: true })),
    ).toBe("unread");
    expect(sessionBucket(row({ nodeId: "a", state: "working" }))).toBe(
      "working",
    );
    expect(sessionBucket(row({ nodeId: "a", state: "done" }))).toBe("idle");
    expect(sessionBucket(row({ nodeId: "a" }))).toBe("unknown");
  });
});

describe("groupSessionsByStatus", () => {
  it("keeps the section order and drops empty sections", () => {
    const sections = groupSessionsByStatus([
      row({ nodeId: "idle", state: "done" }),
      row({ nodeId: "work", state: "working", updatedAt: at(2_000) }),
      row({ nodeId: "need", state: "blocked" }),
      row({ nodeId: "work2", state: "working", updatedAt: at(4_000) }),
    ]);

    expect(sections.map((section) => section.bucket)).toEqual([
      "attention",
      "working",
      "idle",
    ]);
    expect(sections[1]!.rows.map((entry) => entry.nodeId)).toEqual([
      "work2",
      "work",
    ]);
  });
});

describe("filterSessions", () => {
  it("matches title and directory, case-insensitively", () => {
    const rows = [
      row({ nodeId: "a", title: "Claude · API" }),
      row({ nodeId: "b", title: "zsh", cwd: "/repo/web" }),
    ];
    expect(filterSessions(rows, "claude").map((entry) => entry.nodeId)).toEqual(
      ["a"],
    );
    expect(filterSessions(rows, "WEB").map((entry) => entry.nodeId)).toEqual([
      "b",
    ]);
    expect(filterSessions(rows, "  ")).toHaveLength(2);
  });
});

describe("basename", () => {
  it("takes the last segment and tolerates trailing separators", () => {
    expect(basename("/repo/apps/web")).toBe("web");
    expect(basename("/repo/apps/web/")).toBe("web");
    expect(basename("C:\\repo\\web")).toBe("web");
    expect(basename("repo")).toBe("repo");
  });
});
