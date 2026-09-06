// C02 的画布：画框套画框，里面一个终端和一个便签，一条上下文连线，一张白板快照，
// 外加一段多行非 ASCII 备注。切换前后比对的就是这份文档。
import { runtimeRoot } from "./harness.mjs";

export const uuid = () => crypto.randomUUID();
export const stamp = "2026-09-06T09:00:00.000Z";

export const outerFrame = uuid();
export const innerFrame = uuid();
export const terminalNode = uuid();
export const stickyNode = uuid();
export const contextLink = uuid();
export const note =
  "第一行：迁移前写下的备注\n第二行：ünïcödé 与 emoji-free 文本\n第三行：tail";
export const whiteboard = JSON.stringify({
  schema: 2,
  records: [{ id: "shape:ink", type: "draw", text: "白板笔迹 ünïcödé" }],
});

export function node(id, type, title, x, y, data, extra = {}) {
  return {
    id,
    boardId: "",
    type,
    title,
    color: "#7c5cff",
    position: { x, y },
    labels: [],
    note: "",
    data,
    createdAt: stamp,
    updatedAt: stamp,
    ...extra,
  };
}

/** The C02 document: a frame inside a frame, two children, a link, a snapshot. */
export function documentFor(boardId, stickyContent) {
  const nodes = [
    node(
      outerFrame,
      "group",
      "外层画框",
      0,
      0,
      { kind: "group" },
      {
        size: { width: 900, height: 620 },
      },
    ),
    node(
      innerFrame,
      "group",
      "内层画框",
      60,
      80,
      { kind: "group" },
      {
        size: { width: 720, height: 460 },
        parentId: outerFrame,
      },
    ),
    node(
      terminalNode,
      "terminal",
      "终端节点",
      120,
      160,
      { kind: "terminal", cwd: runtimeRoot, shell: "/bin/sh" },
      {
        size: { width: 420, height: 260 },
        parentId: innerFrame,
        labels: ["运行中", "review"],
        note,
      },
    ),
    node(
      stickyNode,
      "sticky",
      "便签节点",
      600,
      160,
      { kind: "sticky", content: stickyContent },
      {
        size: { width: 240, height: 200 },
        parentId: innerFrame,
        labels: ["笔记"],
        note: "便签自己的备注：ünïcödé",
      },
    ),
  ].map((value) => ({ ...value, boardId }));
  const edges = [
    {
      id: contextLink,
      boardId,
      source: terminalNode,
      target: stickyNode,
      kind: "link",
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];
  return { nodes, edges };
}
