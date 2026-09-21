import { describe, expect, it } from "vitest";

import {
  COMMAND_BY_ID,
  COMMANDS,
  commandKeys,
  type CommandId,
} from "../keybindings";
import { TOOL_GROUPS } from "./interaction/tool-store";
import {
  CANVAS_TOOLS,
  CANVAS_TOOL_IDS,
  DOCK_TOOL_ITEMS,
  GEO_IDS,
  GEO_OPTIONS,
  PHONE_DOCK_TOOL_ITEMS,
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

  it("Dock 排布：选择 / 手 / 笔组 / 形状 / 线组 / 文字，画框不在其中", () => {
    expect(
      DOCK_TOOL_ITEMS.map((item) =>
        item.kind === "group" ? `${item.kind}:${item.group}` : item.tool.id,
      ),
    ).toEqual(["select", "hand", "group:pen", "geo", "group:line", "text"]);
    // 每个工具恰好在排布里出现一次：既没有漏掉的，也没有摆两遍的。
    const placed = DOCK_TOOL_ITEMS.flatMap((item) =>
      item.kind === "group"
        ? item.members.map((member) => member.id)
        : [item.tool.id],
    );
    expect([...placed].sort()).toEqual([...CANVAS_TOOL_IDS].sort());
  });

  it("两个组的成员与 `tool-store` 是同一张表", () => {
    const groups = Object.fromEntries(
      DOCK_TOOL_ITEMS.filter((item) => item.kind === "group").map((item) => [
        item.group,
        item.members.map((member) => member.id),
      ]),
    );
    expect(groups).toEqual({
      pen: [...TOOL_GROUPS.pen],
      line: [...TOOL_GROUPS.line],
    });
  });

  it("手机那一份不变：只有选择与手，没有任何下拉", () => {
    expect(PHONE_DOCK_TOOL_ITEMS.map((item) => item.kind)).toEqual([
      "tool",
      "tool",
    ]);
    expect(
      PHONE_DOCK_TOOL_ITEMS.map((item) =>
        item.kind === "group" ? item.group : item.tool.id,
      ),
    ).toEqual([...PHONE_TOOL_IDS]);
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
  it("绘制类工具一律显示：马上要画的东西需要先挑样式", () => {
    for (const tool of ["draw", "highlight", "geo", "line", "arrow", "text"]) {
      expect(shouldShowStylePanel(tool, [])).toBe(true);
    }
  });

  it("选择 / 手形 + 什么都没选 → 隐藏", () => {
    expect(shouldShowStylePanel("select", [])).toBe(false);
    // 手形只平移视口，画不出任何东西（2026-09-21 用户反馈）。
    expect(shouldShowStylePanel("hand", [])).toBe(false);
  });

  it("手形 + 选中白板对象 → 仍然显示：面板改的是选中项", () => {
    expect(shouldShowStylePanel("hand", ["wb:abc"])).toBe(true);
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
