import { describe, expect, it } from "vitest";
import type { CanvasNode } from "@armadra/shared";

import { subagentNodeId, type SubagentCardModel } from "@/agent/subagent-store";
import {
  CARD_GAP,
  CARD_HEIGHT,
  CARD_MAX_WIDTH,
  CARD_MIN_WIDTH,
  CARD_OFFSET,
  buildSubagentPlacements,
} from "./SubagentLayer";

const BOARD = "019ff7d1-0d12-7421-833d-2c5e8d64ed00";
const PARENT = "019ff7d1-0d12-7421-833d-2c5e8d64ed01";
const OTHER = "019ff7d1-0d12-7421-833d-2c5e8d64ed02";

function terminal(id: string, patch: Partial<CanvasNode> = {}): CanvasNode {
  const now = "2026-09-04T10:00:00.000Z";
  return {
    id,
    boardId: BOARD,
    type: "terminal",
    title: id.slice(0, 4),
    color: "#0a84ff",
    position: { x: 100, y: 200 },
    size: { width: 320, height: 240 },
    data: { kind: "terminal" },
    createdAt: now,
    updatedAt: now,
    ...patch,
  } as CanvasNode;
}

function card(id: string, parentId: string): SubagentCardModel {
  return { id, parentId, taskLabel: id, startedAt: 0, state: "working" };
}

describe("subagent card placement", () => {
  it("stacks the cards under the parent's bottom edge", () => {
    const parent = terminal(PARENT);
    const placements = buildSubagentPlacements([parent], {
      [PARENT]: [card("tool-1", PARENT), card("tool-2", PARENT)],
    });

    expect(placements.map((item) => item.id)).toEqual([
      subagentNodeId("tool-1"),
      subagentNodeId("tool-2"),
    ]);
    // 第一张：父节点底边（200 + 240）下方 CARD_OFFSET。
    expect(placements[0]).toMatchObject({
      x: 100,
      y: 200 + 240 + CARD_OFFSET,
      width: 320,
    });
    // 后面每一张再落 CARD_HEIGHT + CARD_GAP。
    expect(placements[1]!.y - placements[0]!.y).toBe(CARD_HEIGHT + CARD_GAP);
  });

  it("follows a collapsed parent up to its collapsed height", () => {
    const parent = terminal(PARENT, { collapsed: true });
    const [placement] = buildSubagentPlacements([parent], {
      [PARENT]: [card("tool-1", PARENT)],
    });
    expect(placement!.y).toBe(200 + 40 + CARD_OFFSET);
  });

  it("clamps the card width to the node width", () => {
    const narrow = terminal(PARENT, { size: { width: 180, height: 120 } });
    const wide = terminal(OTHER, { size: { width: 900, height: 120 } });
    const placements = buildSubagentPlacements([narrow, wide], {
      [PARENT]: [card("tool-1", PARENT)],
      [OTHER]: [card("tool-2", OTHER)],
    });
    expect(placements[0]!.width).toBe(CARD_MIN_WIDTH);
    expect(placements[1]!.width).toBe(CARD_MAX_WIDTH);
  });

  it("keeps a group member's card in absolute page coordinates", () => {
    const group = terminal(OTHER, {
      type: "group",
      position: { x: 1000, y: 500 },
      size: { width: 800, height: 600 },
      data: { kind: "group" },
    });
    // 组员的 position 是相对组框的，卡片必须落在换算后的页面坐标上。
    const member = terminal(PARENT, {
      parentId: OTHER,
      position: { x: 40, y: 60 },
      size: { width: 300, height: 200 },
    });
    const [placement] = buildSubagentPlacements([group, member], {
      [PARENT]: [card("tool-1", PARENT)],
    });
    expect(placement).toMatchObject({
      x: 1040,
      y: 560 + 200 + CARD_OFFSET,
    });
  });

  it("skips cards whose parent left the board", () => {
    expect(
      buildSubagentPlacements([], { [PARENT]: [card("tool-1", PARENT)] }),
    ).toEqual([]);
    expect(buildSubagentPlacements([terminal(PARENT)], {})).toEqual([]);
  });
});
