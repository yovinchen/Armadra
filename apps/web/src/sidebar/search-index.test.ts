import { describe, expect, it } from "vitest";
import type { CanvasNode } from "@armadra/shared";

import {
  searchBoards,
  snippetAround,
  stickyContent,
  type SearchBoard,
} from "./search-index";

const timestamp = "2026-09-05T10:00:00.000Z";

function sticky(id: string, title: string, content: string): CanvasNode {
  return {
    id,
    boardId: "board",
    type: "sticky",
    title,
    color: "#5B5BD6",
    position: { x: 0, y: 0 },
    labels: [],
    note: "",
    data: { kind: "sticky", content },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function terminal(id: string, title: string): CanvasNode {
  return {
    ...sticky(id, title, ""),
    type: "terminal",
    data: { kind: "terminal" },
  };
}

const boards: SearchBoard[] = [
  {
    id: "b1",
    name: "Default",
    nodes: [
      terminal("n1", "构建流水线"),
      sticky("n2", "待办", "先修好 tmux 降级那条横幅，再看导出"),
    ],
  },
  { id: "b2", name: "tmux 实验", nodes: [terminal("n3", "空跑")] },
];

describe("stickyContent", () => {
  it("只有便签有正文", () => {
    expect(stickyContent(sticky("n", "t", "正文"))).toBe("正文");
    expect(stickyContent(terminal("n", "t"))).toBe("");
  });
});

describe("snippetAround", () => {
  it("短正文原样返回，空白压成单个空格", () => {
    expect(snippetAround("一行\n  两行", "")).toBe("一行 两行");
  });

  it("长正文围绕命中处截断，两端补省略号", () => {
    const text = `${"甲".repeat(200)}命中${"乙".repeat(200)}`;
    const snippet = snippetAround(text, "命中", 20);
    expect(snippet.includes("命中")).toBe(true);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("没命中就截开头", () => {
    expect(snippetAround("abcdefghij", "zz", 5)).toBe("abcde…");
  });
});

describe("searchBoards", () => {
  it("空查询列出全部，看板在节点前面", () => {
    const hits = searchBoards(boards, "");
    expect(hits.slice(0, 2).map((hit) => hit.id)).toEqual(["b1", "b2"]);
    expect(hits.filter((hit) => hit.kind === "node")).toHaveLength(3);
  });

  it("看板名、节点标题、便签正文三处都能命中", () => {
    expect(searchBoards(boards, "tmux").map((hit) => hit.id)).toEqual([
      "b2",
      "n2",
    ]);
    expect(searchBoards(boards, "流水线").map((hit) => hit.id)).toEqual(["n1"]);
  });

  it("标题命中排在正文命中前面", () => {
    const withTitle: SearchBoard[] = [
      {
        id: "b3",
        name: "板",
        nodes: [
          sticky("c", "无关", "命中在正文里"),
          terminal("t", "命中在标题里"),
        ],
      },
    ];
    expect(searchBoards(withTitle, "命中").map((hit) => hit.id)).toEqual([
      "t",
      "c",
    ]);
  });

  it("便签命中带正文摘要，看板命中不带", () => {
    const [board, node] = searchBoards(boards, "tmux");
    expect(board!.snippet).toBeUndefined();
    expect(node!.snippet).toContain("tmux");
    expect(node!.boardName).toBe("Default");
  });

  it("大小写不敏感，并且尊重上限", () => {
    expect(searchBoards(boards, "DEFAULT").map((hit) => hit.id)).toEqual([
      "b1",
    ]);
    expect(searchBoards(boards, "", 2)).toHaveLength(2);
  });
});
