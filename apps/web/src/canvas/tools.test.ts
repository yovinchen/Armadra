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
  GEO_IDS,
  GEO_OPTIONS,
  PHONE_TOOL_IDS,
  geoIcon,
  isToolDisabledWhenLocked,
  shouldShowStylePanel,
  splitSelectionForDelete,
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

  it("键位与 v3 / 旧引擎逐字一致：换引擎不改肌肉记忆", () => {
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

  it("形状下拉与 `Geo` 类型是同一张表，漏一种是编译错误", () => {
    expect(GEO_OPTIONS.map((option) => option.geo)).toEqual([...GEO_IDS]);
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

const NODE = "11111111-1111-4111-8111-111111111111";
const OTHER_NODE = "22222222-2222-4222-8222-222222222222";
const EDGE = "33333333-3333-4333-8333-333333333333";

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

  it("选中的全是节点 → 隐藏（节点的颜色走右键菜单）", () => {
    expect(shouldShowStylePanel("select", [NODE, OTHER_NODE])).toBe(false);
  });

  it("选中项里有白板对象 → 显示，混合多选也显示", () => {
    expect(shouldShowStylePanel("select", ["wb:abc"])).toBe(true);
    expect(shouldShowStylePanel("select", [NODE, "wb:abc"])).toBe(true);
  });
});

/* -------------------------------- 删除 ------------------------------------ */

describe("splitSelectionForDelete", () => {
  const nodes = new Set([NODE, OTHER_NODE]);
  const edges = new Set([EDGE]);
  const REFERENCE = "77777777-7777-4777-8777-777777777777";
  const references = new Set([REFERENCE]);

  it("按 id 前缀分流：白板对象 / 节点 / 边各归各的堆", () => {
    expect(
      splitSelectionForDelete([NODE, EDGE, "wb:abc123"], nodes, edges),
    ).toEqual({
      nodes: [NODE],
      edges: [EDGE],
      items: ["wb:abc123"],
      references: [],
    });
  });

  it("白板对象不查表：文档里本来就没有它们", () => {
    const split = splitSelectionForDelete(
      ["wb:one", "wb:two"],
      new Set(),
      new Set(),
    );
    expect(split.items).toEqual(["wb:one", "wb:two"]);
    expect(split.nodes).toEqual([]);
  });

  it("三张表都不认的 id 一概不动：删了也同步不回去", () => {
    const ghost = "55555555-5555-4555-8555-555555555555";
    expect(splitSelectionForDelete([ghost], nodes, edges, references)).toEqual({
      nodes: [],
      edges: [],
      items: [],
      references: [],
    });
  });

  it("节点 + 白板对象混合多选时两边都删", () => {
    const split = splitSelectionForDelete(
      [NODE, "wb:ink1", "wb:text1"],
      nodes,
      edges,
    );
    expect(split.nodes).toEqual([NODE]);
    expect(split.items).toEqual(["wb:ink1", "wb:text1"]);
  });

  it("引用与连线在选区里混着，删除时分到两堆（F29）", () => {
    const split = splitSelectionForDelete(
      [EDGE, REFERENCE],
      nodes,
      edges,
      references,
    );
    expect(split.edges).toEqual([EDGE]);
    expect(split.references).toEqual([REFERENCE]);
  });

  it("不给引用表时引用 id 落空：删不掉，也不会被当成连线误删", () => {
    const split = splitSelectionForDelete([REFERENCE], nodes, edges);
    expect(split.references).toEqual([]);
    expect(split.edges).toEqual([]);
  });

  it("空选区什么也不删", () => {
    expect(splitSelectionForDelete([], nodes, edges, references)).toEqual({
      nodes: [],
      edges: [],
      items: [],
      references: [],
    });
  });
});
