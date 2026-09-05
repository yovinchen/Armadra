import { describe, expect, it } from "vitest";

import {
  COMMAND_BY_ID,
  COMMANDS,
  commandKeys,
  type CommandId,
} from "../keybindings";
import {
  CANVAS_TOOLS,
  CANVAS_TOOL_IDS,
  GEO_OPTIONS,
  geoIcon,
  isToolDisabledWhenLocked,
  isWhiteboardShapeType,
  shouldShowStylePanel,
  splitSelectionForDelete,
  type SelectedShapeInfo,
} from "./tools";

/* ------------------------------ 工具键表 ---------------------------------- */

describe("工具键表", () => {
  it("每个工具都有一条命令，且命令 id 就是 `canvas.tool.<工具 id>`", () => {
    expect(CANVAS_TOOLS.map((tool) => tool.id)).toEqual([...CANVAS_TOOL_IDS]);
    for (const tool of CANVAS_TOOLS) {
      expect(tool.command).toBe(`canvas.tool.${tool.id}`);
      expect(COMMAND_BY_ID[tool.command as CommandId]).toBeDefined();
    }
  });

  it("键位照抄 tldraw 默认", () => {
    const keys = Object.fromEntries(
      CANVAS_TOOLS.map((tool) => [
        tool.id,
        commandKeys(tool.command as CommandId, { mac: true }),
      ]),
    );
    expect(keys).toEqual({
      select: "V",
      hand: "H",
      draw: "D",
      highlight: "Shift+D",
      geo: "R",
      line: "L",
      arrow: "A",
      text: "T",
      frame: "F",
    });
  });

  it("终端与输入框里一律不截走：单字母键必须原样进 xterm", () => {
    for (const tool of CANVAS_TOOLS) {
      const command = COMMAND_BY_ID[tool.command as CommandId];
      expect(command.scope).toBe("canvas");
      expect(command.allowInTerminal).toBe(false);
      expect(command.allowWhileTyping).toBe(false);
    }
  });

  it("两个平台键位一致，且没有和别的命令撞车", () => {
    const seen = new Map<string, string>();
    for (const command of COMMANDS) {
      for (const platform of ["mac", "other"] as const) {
        const chords = command.defaultKeys[platform];
        if (!chords) continue;
        for (const chord of chords.split(",")) {
          const key = `${platform}:${chord}`;
          expect(seen.get(key)).toBeUndefined();
          seen.set(key, command.id);
        }
      }
    }
    for (const tool of CANVAS_TOOLS) {
      const command = COMMAND_BY_ID[tool.command as CommandId];
      expect(command.defaultKeys.mac).toBe(command.defaultKeys.other);
    }
  });

  it("每条工具命令都有 i18n 键，形状下拉每一项也有", () => {
    for (const tool of CANVAS_TOOLS) {
      expect(tool.labelKey).toBe(`tool.${tool.id}`);
      expect(COMMAND_BY_ID[tool.command as CommandId].labelKey).toBe(
        `cmd.canvas.tool.${tool.id}`,
      );
    }
    for (const option of GEO_OPTIONS) {
      expect(option.labelKey).toBe(`geo.${option.geo}`);
    }
  });

  it("形状图标跟着 geo 样式走，未知值退回矩形", () => {
    expect(geoIcon("ellipse")).toBe(
      GEO_OPTIONS.find((option) => option.geo === "ellipse")?.icon,
    );
    expect(geoIcon("cloud")).toBe(
      GEO_OPTIONS.find((option) => option.geo === "rectangle")?.icon,
    );
  });

  it("锁定时只剩选择可用", () => {
    expect(isToolDisabledWhenLocked("select")).toBe(false);
    for (const tool of CANVAS_TOOLS.filter((item) => item.id !== "select")) {
      expect(isToolDisabledWhenLocked(tool.id)).toBe(true);
    }
  });
});

/* ------------------------------ 样式面板 ---------------------------------- */

describe("shouldShowStylePanel", () => {
  it("不是选择工具时一律显示：马上要画的东西需要先挑样式", () => {
    for (const tool of ["draw", "geo", "arrow", "text", "frame", "highlight"]) {
      expect(shouldShowStylePanel(tool, [])).toBe(true);
    }
  });

  it("选择工具 + 什么都没选 → 隐藏", () => {
    expect(shouldShowStylePanel("select", [])).toBe(false);
  });

  it("选中的全是节点 → 隐藏（节点没有 tldraw 样式）", () => {
    expect(shouldShowStylePanel("select", ["armadra", "armadra"])).toBe(false);
  });

  it("选中项里有白板 shape → 显示，混合多选也显示", () => {
    expect(shouldShowStylePanel("select", ["geo"])).toBe(true);
    expect(shouldShowStylePanel("select", ["armadra", "arrow"])).toBe(true);
    expect(shouldShowStylePanel("select", ["frame"])).toBe(true);
  });

  it("isWhiteboardShapeType 只把 `armadra` 排除在外", () => {
    expect(isWhiteboardShapeType("armadra")).toBe(false);
    expect(isWhiteboardShapeType("draw")).toBe(true);
    expect(isWhiteboardShapeType("frame")).toBe(true);
  });
});

/* -------------------------------- 删除 ------------------------------------ */

const NODE = "11111111-1111-4111-8111-111111111111";
const OTHER_NODE = "22222222-2222-4222-8222-222222222222";
const EDGE = "33333333-3333-4333-8333-333333333333";

function info(patch: Partial<SelectedShapeInfo>): SelectedShapeInfo {
  return { id: "shape:x", type: "geo", edgeId: null, nodeId: null, ...patch };
}

describe("splitSelectionForDelete", () => {
  const nodes = new Set([NODE, OTHER_NODE]);
  const edges = new Set([EDGE]);

  it("节点 / 边 / 白板 shape 各归各的堆", () => {
    const split = splitSelectionForDelete(
      [
        info({ id: `shape:${NODE}`, type: "armadra", nodeId: NODE }),
        info({ id: `shape:${EDGE}`, type: "arrow", edgeId: EDGE }),
        info({ id: "shape:abc123", type: "geo" }),
      ],
      nodes,
      edges,
    );
    expect(split).toEqual({
      nodes: [NODE],
      edges: [EDGE],
      shapes: ["shape:abc123"],
    });
  });

  it("没绑定的箭头是白板内容，直接删（Phase 2 待办 1）", () => {
    const split = splitSelectionForDelete(
      [info({ id: "shape:loose", type: "arrow" })],
      nodes,
      edges,
    );
    expect(split.shapes).toEqual(["shape:loose"]);
    expect(split.edges).toEqual([]);
  });

  it("`meta` 上写着边 id 但文档里没有这条边 → 当白板箭头删", () => {
    const split = splitSelectionForDelete(
      [
        info({
          id: "shape:ghost",
          type: "arrow",
          edgeId: "44444444-4444-4444-8444-444444444444",
        }),
      ],
      nodes,
      edges,
    );
    expect(split.edges).toEqual([]);
    expect(split.shapes).toEqual(["shape:ghost"]);
  });

  it("文档里不存在的节点 shape 一概不动", () => {
    const split = splitSelectionForDelete(
      [
        info({
          id: "shape:55555555-5555-4555-8555-555555555555",
          type: "armadra",
          nodeId: "55555555-5555-4555-8555-555555555555",
        }),
      ],
      nodes,
      edges,
    );
    expect(split).toEqual({ nodes: [], edges: [], shapes: [] });
  });

  it("节点 + 白板 shape 混合多选时两边都删", () => {
    const split = splitSelectionForDelete(
      [
        info({ id: `shape:${NODE}`, type: "armadra", nodeId: NODE }),
        info({ id: "shape:draw1", type: "draw" }),
        info({ id: "shape:frame1", type: "frame" }),
      ],
      nodes,
      edges,
    );
    expect(split.nodes).toEqual([NODE]);
    expect(split.shapes).toEqual(["shape:draw1", "shape:frame1"]);
  });

  it("空选区什么也不删", () => {
    expect(splitSelectionForDelete([], nodes, edges)).toEqual({
      nodes: [],
      edges: [],
      shapes: [],
    });
  });
});
