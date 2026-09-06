import { describe, expect, it } from "vitest";
import type { SessionRow } from "../agent/sessions";

import { AGENT_BUCKET_ORDER, agentSections, bucketTone } from "./agent-panel";

function row(patch: Partial<SessionRow> & { nodeId: string }): SessionRow {
  return {
    boardId: "b1",
    sessionId: `s-${patch.nodeId}`,
    title: patch.nodeId,
    cwd: "/repo",
    unread: false,
    updatedAt: "2026-09-05T10:00:00.000Z",
    alive: true,
    sinceMs: 0,
    ...patch,
  };
}

describe("agentSections", () => {
  it("按「需要你 → 运行中 → 未读 → 空闲」排分区", () => {
    const sections = agentSections([
      row({ nodeId: "idle", state: "done" }),
      row({ nodeId: "unread", state: "done", unread: true }),
      row({ nodeId: "working", state: "working" }),
      row({ nodeId: "attention", state: "waiting" }),
    ]);
    expect(sections.map((section) => section.bucket)).toEqual([
      "attention",
      "working",
      "unread",
      "idle",
    ]);
  });

  it("已经结束的会话不进面板", () => {
    const sections = agentSections([
      row({ nodeId: "dead", state: "working", alive: false }),
      row({ nodeId: "live", state: "working" }),
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.rows.map((item) => item.nodeId)).toEqual(["live"]);
  });

  it("空列表就没有分区", () => {
    expect(agentSections([])).toEqual([]);
  });
});

describe("bucketTone", () => {
  it("每个分区都有胶囊色，未知与空闲同色", () => {
    expect(AGENT_BUCKET_ORDER.map(bucketTone)).toEqual([
      "attention",
      "working",
      "unread",
      "idle",
      "idle",
    ]);
  });
});
