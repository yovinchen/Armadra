import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Board,
  BoardDocument,
  CanvasEdge,
  CanvasNode,
  CanvasNodeType,
  Workspace,
} from "@armadra/shared";

/**
 * `store/defaults.ts` 从 `nodes/registry.ts` 取尺寸/颜色/标签（归属 nodes
 * agent，模块里还挂着 8 个节点体与 xterm）。store 的单测不该把整棵渲染树
 * 拉进来，所以这里按 §13.2 的形状造一份最小 NODE_META。
 */
vi.mock("../nodes/registry", () => {
  const meta = (
    labelKey: string,
    width: number,
    height: number,
    color = "#0a84ff",
  ) => ({
    labelKey,
    icon: null,
    defaultSize: { width, height },
    minSize: { width: 160, height: 120 },
    defaultColor: color,
    hasBridgeHandles: false,
  });
  const table: Record<string, ReturnType<typeof meta>> = {
    terminal: meta("node.terminal", 640, 440),
    sticky: meta("node.sticky", 240, 200, "#ffd60a"),
    group: meta("node.group", 520, 360),
    editor: meta("node.editor", 660, 460),
    diff: meta("node.diff", 860, 500),
    files: meta("node.files", 340, 460),
    browser: meta("node.browser", 800, 560),
  };
  return { NODE_META: table, nodeMeta: (type: string) => table[type] };
});

const { COLLAPSED_HEIGHT } = await import("./defaults");
const { absolutePosition, resetHistory, useCanvasStore } = await import(
  "./canvas-store"
);
const { emptyWhiteboard } = await import("../canvas/whiteboard/model");

const timestamp = "2026-08-13T00:00:00.000Z";

const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "One",
  rootPath: "/tmp/one",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const board: Board = {
  id: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
  workspaceId: workspace.id,
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: timestamp,
  updatedAt: timestamp,
};

let counter = 0;
function uuid(): string {
  counter += 1;
  return `019ff7d1-0000-7000-8000-${String(counter).padStart(12, "0")}`;
}

function makeNode(
  type: CanvasNodeType,
  overrides: Partial<CanvasNode> = {},
): CanvasNode {
  return {
    id: uuid(),
    boardId: board.id,
    type,
    title: type,
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    data: { kind: type } as CanvasNode["data"],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  } as CanvasNode;
}

function edge(source: string, target: string): CanvasEdge {
  return {
    id: uuid(),
    boardId: board.id,
    source,
    target,
    kind: "link",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function load(nodes: CanvasNode[] = [], edges: CanvasEdge[] = []) {
  const document: BoardDocument = { board, nodes, edges };
  useCanvasStore.getState().setWorkspace(workspace);
  useCanvasStore.getState().setDocument(document);
}

const state = () => useCanvasStore.getState();
const nodes = () => state().document?.nodes ?? [];
const edges = () => state().document?.edges ?? [];
const byId = (id: string) => nodes().find((node) => node.id === id);

beforeEach(() => {
  counter = 0;
  resetHistory();
  useCanvasStore.setState({
    workspace: null,
    boards: [],
    boardId: null,
    document: null,
    whiteboard: emptyWhiteboard(),
    selectedNodeIds: [],
    selectedEdgeIds: [],
    selectedItemIds: [],
    focusNodeId: null,
    maximized: {},
    saveState: "idle",
    saveError: null,
  });
});

describe("工作空间与画布", () => {
  it("换工作空间会清掉旧文档", () => {
    load([makeNode("sticky")]);
    state().setWorkspace({ ...workspace, id: uuid(), name: "Two" });
    expect(state().document).toBeNull();
    expect(state().boardId).toBeNull();
  });

  it("同一个工作空间重复设置不清文档", () => {
    load([makeNode("sticky")]);
    state().setWorkspace({ ...workspace, name: "改名了" });
    expect(state().document?.nodes).toHaveLength(1);
  });

  it("画布按 sortOrder 排序，当前画布还在就不重置", () => {
    load();
    state().setBoards([
      { id: "b", name: "B", sortOrder: 2 },
      { id: board.id, name: "Default", sortOrder: 0 },
    ]);
    expect(state().boards.map((item) => item.id)).toEqual([board.id, "b"]);
    expect(state().document).not.toBeNull();
  });

  it("切换画布会清空文档", () => {
    load([makeNode("sticky")]);
    state().selectBoard("other");
    expect(state().document).toBeNull();
  });

  it("setDocument 把保存态设成 saved", () => {
    load([makeNode("sticky")]);
    state().addNode("sticky");
    expect(state().saveState).toBe("dirty");
    load([makeNode("sticky")]);
    expect(state().saveState).toBe("saved");
    expect(nodes()).toHaveLength(1);
  });
});

describe("面板", () => {
  it("只改指定的那一格", () => {
    state().setPanel("sidebar", "collapsed");
    state().setPanel("settings", true);
    expect(state().panels).toMatchObject({
      sidebar: "collapsed",
      settings: true,
      explorer: "closed",
    });
  });

  /**
   * 右侧工作面板共用同一块地方（画布平台设计 §4）。两个抽屉同时开着时后开的
   * 那个正好压在前一个上，用户看到的是「点了没反应」。
   */
  it("右侧抽屉一次只开一个", () => {
    state().setPanel("scm", "drawer");
    state().setPanel("explorer", "drawer");
    expect(state().panels).toMatchObject({ scm: "closed", explorer: "drawer" });
    state().setPanel("usage", "drawer");
    expect(state().panels).toMatchObject({
      explorer: "closed",
      usage: "drawer",
    });
  });

  it("pin 成浮卡的不被别的抽屉挤掉", () => {
    state().setPanel("explorer", "pinned");
    state().setPanel("scm", "drawer");
    expect(state().panels).toMatchObject({ explorer: "pinned", scm: "drawer" });
  });

  it("左侧栏和对话框不参与右侧那条规则", () => {
    state().setPanel("scm", "drawer");
    state().setPanel("sidebar", "open");
    state().setPanel("palette", true);
    expect(state().panels).toMatchObject({ scm: "drawer", palette: true });
  });
});

describe("选择", () => {
  it("去重并丢掉不存在的 id", () => {
    const a = makeNode("sticky");
    load([a]);
    state().selectNodes([a.id, a.id, "ghost"]);
    expect(state().selectedNodeIds).toEqual([a.id]);
  });

  /**
   * 边与白板对象可以和节点一起多选（§2.8）。`selectedNodeIds` 仍然只装
   * 节点，`selectNodes` 不该把另外两格挤掉。
   */
  it("`selectNodes` 只改节点那一格，边与白板对象原样留着", () => {
    const a = makeNode("sticky");
    load([a]);
    const edgeId = "9f1c2b34-5d6e-4f70-8a9b-0c1d2e3f4a5b";
    state().setSelection({ edges: [edgeId], items: ["wb:doodle"] });

    state().selectNodes([a.id]);
    expect(state().selectedNodeIds).toEqual([a.id]);
    expect(state().selectedEdgeIds).toEqual([edgeId]);
    expect(state().selectedItemIds).toEqual(["wb:doodle"]);

    state().selectNodes([]);
    expect(state().selectedNodeIds).toEqual([]);
    expect(state().selectedEdgeIds).toEqual([edgeId]);
  });

  it("`setSelection` 一次写三项，节点仍然按文档过滤", () => {
    const a = makeNode("sticky");
    load([a]);
    state().setSelection({
      nodes: [a.id, "ghost"],
      edges: ["e1"],
      items: ["wb:1", "wb:1"],
    });
    expect(state().selectedNodeIds).toEqual([a.id]);
    expect(state().selectedEdgeIds).toEqual(["e1"]);
    expect(state().selectedItemIds).toEqual(["wb:1"]);
  });

  it("内容相同就返回同一份 state，不触发订阅者重渲", () => {
    const a = makeNode("sticky");
    load([a]);
    state().selectNodes([a.id]);
    const before = state().selectedNodeIds;
    state().selectNodes([a.id]);
    expect(state().selectedNodeIds).toBe(before);
  });
});

describe("addNode", () => {
  it("按 NODE_META 取默认尺寸、颜色与标题", () => {
    load();
    const id = state().addNode("terminal");
    const node = byId(id);
    expect(node?.size).toEqual({ width: 640, height: 440 });
    expect(node?.color).toBe("#0a84ff");
    expect(node?.title).toBe("终端");
    expect(node?.data).toEqual({ kind: "terminal" });
    expect(state().selectedNodeIds).toEqual([id]);
    expect(state().saveState).toBe("dirty");
  });

  it("便签有自己的默认色与空正文", () => {
    load();
    const node = byId(state().addNode("sticky"));
    expect(node?.color).toBe("#ffd60a");
    expect(node?.data).toEqual({ kind: "sticky", content: "" });
  });

  it("files / diff 落在工作空间根目录", () => {
    load();
    expect(byId(state().addNode("files"))?.data).toEqual({
      kind: "files",
      path: "/tmp/one",
    });
    expect(byId(state().addNode("diff"))?.data).toEqual({
      kind: "diff",
      repoPath: "/tmp/one",
      scope: "worktree",
    });
  });

  it("传入的 data 覆盖默认值但改不了 kind", () => {
    load();
    const node = byId(
      state().addNode("terminal", {
        data: { kind: "sticky", agent: { id: "claude" } } as never,
      }),
    );
    expect(node?.data.kind).toBe("terminal");
    expect(node?.data).toMatchObject({ agent: { id: "claude" } });
  });

  it("没有文档时返回空串且不炸", () => {
    expect(state().addNode("sticky")).toBe("");
  });

  it("绑定了 worktree 的分组里，新节点继承那个目录（G03）", () => {
    const bound = makeNode("group", {
      size: { width: 400, height: 300 },
      position: { x: 100, y: 100 },
      data: {
        kind: "group",
        binding: {
          worktreePath: "wt/feature",
          branch: "feature",
          repositoryId: "repo",
          initScript: null,
          initScriptState: "none",
          initScriptNodeId: null,
        },
      } as never,
    });
    load([bound]);
    // 终端的 cwd 会被原样交给子进程，所以是绝对路径；其余是工作区相对。
    expect(
      byId(state().addNode("terminal", { parentId: bound.id }))?.data,
    ).toEqual({ kind: "terminal", cwd: "/tmp/one/wt/feature" });
    expect(
      byId(state().addNode("files", { parentId: bound.id }))?.data,
    ).toEqual({ kind: "files", path: "wt/feature" });
    // 右键新建只给落点，也要认得自己落在哪个绑定分组里。
    expect(
      byId(state().addNode("editor", { position: { x: 200, y: 200 } }))?.data,
    ).toEqual({ kind: "editor", path: "wt/feature" });
    // 调用方显式给的 data 仍然压在最上面。
    expect(
      byId(
        state().addNode("terminal", {
          parentId: bound.id,
          data: { kind: "terminal", cwd: "/tmp/elsewhere" },
        }),
      )?.data,
    ).toEqual({ kind: "terminal", cwd: "/tmp/elsewhere" });
  });

  it("没绑定的分组不影响新节点的默认目录", () => {
    const plain = makeNode("group", { size: { width: 400, height: 300 } });
    load([plain]);
    expect(
      byId(state().addNode("terminal", { parentId: plain.id }))?.data,
    ).toEqual({ kind: "terminal" });
  });

  it("select:false 不改选择", () => {
    const a = makeNode("sticky");
    load([a]);
    state().selectNodes([a.id]);
    state().addNode("sticky", { select: false });
    expect(state().selectedNodeIds).toEqual([a.id]);
  });
});

describe("updateNode / updateNodeData", () => {
  it("改标题与颜色置 dirty", () => {
    const a = makeNode("sticky");
    load([a]);
    state().updateNode(a.id, { title: "构建", color: "#32d74b" });
    expect(byId(a.id)).toMatchObject({ title: "构建", color: "#32d74b" });
    expect(state().saveState).toBe("dirty");
  });

  it("updateNodeData 浅合并且保住 kind", () => {
    const a = makeNode("sticky", { data: { kind: "sticky", content: "" } });
    load([a]);
    state().updateNodeData(a.id, { content: "写点什么" } as never);
    expect(byId(a.id)?.data).toEqual({ kind: "sticky", content: "写点什么" });
  });

  it("id 不存在时不产生新状态", () => {
    const a = makeNode("sticky");
    load([a]);
    const before = state().document;
    state().updateNode("ghost", { title: "x" });
    expect(state().document).toBe(before);
  });
});

describe("moveNodes / resizeNode", () => {
  it("一次调用提交所有位置", () => {
    const a = makeNode("sticky");
    const b = makeNode("sticky");
    load([a, b]);
    state().moveNodes([
      { id: a.id, position: { x: 10, y: 20 } },
      { id: b.id, position: { x: 30, y: 40 } },
    ]);
    expect(byId(a.id)?.position).toEqual({ x: 10, y: 20 });
    expect(byId(b.id)?.position).toEqual({ x: 30, y: 40 });
    expect(state().saveState).toBe("dirty");
  });

  it("位置没变就不换文档", () => {
    const a = makeNode("sticky");
    load([a]);
    const before = state().document;
    state().moveNodes([{ id: a.id, position: { x: 0, y: 0 } }]);
    expect(state().document).toBe(before);
  });

  it("resize 同时记下新的展开高度", () => {
    const a = makeNode("sticky");
    load([a]);
    state().resizeNode(a.id, { width: 300, height: 260 }, { x: 5, y: 5 });
    expect(byId(a.id)).toMatchObject({
      size: { width: 300, height: 260 },
      position: { x: 5, y: 5 },
      expandedHeight: 260,
    });
  });
});

describe("折叠", () => {
  it("折叠到 40px 并记住展开高度", () => {
    const a = makeNode("terminal", { size: { width: 640, height: 440 } });
    load([a]);
    state().setCollapsed(a.id, true);
    expect(byId(a.id)).toMatchObject({
      collapsed: true,
      expandedHeight: 440,
      size: { width: 640, height: COLLAPSED_HEIGHT },
    });
    state().setCollapsed(a.id, false);
    expect(byId(a.id)?.size).toEqual({ width: 640, height: 440 });
  });

  it("折叠捕获当前尺寸，不恢复原生拖拽前的旧高度", () => {
    const a = makeNode("terminal", {
      size: { width: 640, height: 720 },
      expandedHeight: 440,
    });
    load([a]);
    state().setCollapsed(a.id, true);
    expect(byId(a.id)?.expandedHeight).toBe(720);
    state().setCollapsed(a.id, false);
    expect(byId(a.id)?.size).toEqual({ width: 640, height: 720 });
  });

  it("折叠只置 dirty", () => {
    const a = makeNode("terminal");
    load([a]);
    state().setCollapsed(a.id, true);
    expect(state().saveState).toBe("dirty");
  });
});

describe("最大化", () => {
  it("记下 premaxRect，还原时装回位置、尺寸与父组", () => {
    const group = makeNode("group", { size: { width: 500, height: 400 } });
    const child = makeNode("terminal", {
      parentId: group.id,
      position: { x: 20, y: 20 },
      size: { width: 300, height: 200 },
    });
    load([group, child]);

    state().maximizeNode(child.id, { x: 24, y: 24, width: 1200, height: 800 });
    expect(state().maximized[child.id]).toEqual({
      x: 20,
      y: 20,
      width: 300,
      height: 200,
      parentId: group.id,
    });
    expect(byId(child.id)).toMatchObject({
      parentId: undefined,
      position: { x: 24, y: 24 },
      size: { width: 1200, height: 800 },
    });

    state().restoreNode(child.id);
    expect(state().maximized[child.id]).toBeUndefined();
    expect(byId(child.id)).toMatchObject({
      parentId: group.id,
      position: { x: 20, y: 20 },
      size: { width: 300, height: 200 },
    });
  });

  it("重复最大化不会覆盖 premaxRect", () => {
    const a = makeNode("terminal", { position: { x: 7, y: 9 } });
    load([a]);
    state().maximizeNode(a.id, { x: 0, y: 0, width: 900, height: 600 });
    state().maximizeNode(a.id, { x: 1, y: 1, width: 100, height: 100 });
    expect(state().maximized[a.id]).toMatchObject({ x: 7, y: 9 });
  });
});

describe("分组", () => {
  it("加入组时位置换成相对坐标", () => {
    const group = makeNode("group", { position: { x: 100, y: 100 } });
    const child = makeNode("terminal", { position: { x: 160, y: 220 } });
    load([group, child]);
    state().setParent([child.id], group.id);
    expect(byId(child.id)).toMatchObject({
      parentId: group.id,
      position: { x: 60, y: 120 },
    });
  });

  it("移出组时换回绝对坐标", () => {
    const group = makeNode("group", { position: { x: 100, y: 100 } });
    const child = makeNode("terminal", {
      parentId: group.id,
      position: { x: 60, y: 120 },
    });
    load([group, child]);
    state().setParent([child.id], null);
    expect(byId(child.id)).toMatchObject({
      parentId: undefined,
      position: { x: 160, y: 220 },
    });
  });

  it("组不能进组，也不能当自己的父", () => {
    const outer = makeNode("group", { position: { x: 0, y: 0 } });
    const inner = makeNode("group", { position: { x: 50, y: 50 } });
    load([outer, inner]);
    state().setParent([inner.id], outer.id);
    expect(byId(inner.id)?.parentId).toBeUndefined();
    state().setParent([outer.id], outer.id);
    expect(byId(outer.id)?.parentId).toBeUndefined();
  });

  it("absolutePosition 逐层累加", () => {
    const group = makeNode("group", { position: { x: 10, y: 10 } });
    const child = makeNode("sticky", {
      parentId: group.id,
      position: { x: 5, y: 5 },
    });
    expect(absolutePosition([group, child], child)).toEqual({ x: 15, y: 15 });
  });
});

describe("removeNodes", () => {
  it("删组时先把组员解组并还回绝对坐标", () => {
    const group = makeNode("group", { position: { x: 100, y: 100 } });
    const child = makeNode("terminal", {
      parentId: group.id,
      position: { x: 20, y: 30 },
    });
    load([group, child]);
    state().removeNodes([group.id]);
    expect(nodes()).toHaveLength(1);
    expect(byId(child.id)).toMatchObject({
      parentId: undefined,
      position: { x: 120, y: 130 },
    });
  });

  it("连带删掉两端任一被删的连线", () => {
    const a = makeNode("terminal");
    const b = makeNode("terminal");
    load([a, b], [edge(a.id, b.id)]);
    state().removeNodes([a.id]);
    expect(edges()).toEqual([]);
  });

  it("清掉选择、焦点与最大化记录", () => {
    const a = makeNode("terminal");
    load([a]);
    state().selectNodes([a.id]);
    state().setFocusNode(a.id);
    state().maximizeNode(a.id, { x: 0, y: 0, width: 10, height: 10 });
    state().removeNodes([a.id]);
    expect(state().selectedNodeIds).toEqual([]);
    expect(state().focusNodeId).toBeNull();
    expect(state().maximized).toEqual({});
  });

  it("空列表或不存在的 id 不换文档", () => {
    load([makeNode("sticky")]);
    const before = state().document;
    state().removeNodes([]);
    state().removeNodes(["ghost"]);
    expect(state().document).toBe(before);
  });
});

describe("duplicateNodes", () => {
  it("偏移 32px、换新 id，并抹掉会话句柄", () => {
    const a = makeNode("terminal", {
      position: { x: 10, y: 10 },
      data: {
        kind: "terminal",
        sessionId: "019ff7d1-1111-7000-8000-000000000001",
        agent: { id: "claude", sessionId: "abc" },
      },
    });
    load([a]);
    const [copyId] = state().duplicateNodes([a.id]);
    const copy = byId(copyId!);
    expect(copy?.id).not.toBe(a.id);
    expect(copy?.position).toEqual({ x: 42, y: 42 });
    expect(copy?.data).toMatchObject({ kind: "terminal" });
    expect((copy?.data as { sessionId?: string }).sessionId).toBeUndefined();
    expect(
      (copy?.data as { agent?: { sessionId?: string } }).agent?.sessionId,
    ).toBeUndefined();
    expect((copy?.data as { agent?: { id: string } }).agent?.id).toBe("claude");
    expect(state().selectedNodeIds).toEqual([copyId]);
  });

  it("副本被选中，原节点数据不受影响", () => {
    const a = makeNode("sticky", { data: { kind: "sticky", content: "原文" } });
    load([a]);
    const [copyId] = state().duplicateNodes([a.id]);
    state().updateNodeData(copyId!, { content: "副本" } as never);
    expect((byId(a.id)?.data as { content: string }).content).toBe("原文");
  });

  it("空选择返回空数组", () => {
    load([makeNode("sticky")]);
    expect(state().duplicateNodes([])).toEqual([]);
  });
});

describe("addEdge", () => {
  it("建立一条 link 并返回 id", () => {
    const a = makeNode("terminal");
    const b = makeNode("terminal");
    load([a, b]);
    const id = state().addEdge(a.id, b.id);
    expect(id).not.toBeNull();
    expect(edges()[0]).toMatchObject({
      source: a.id,
      target: b.id,
      kind: "link",
    });
  });

  it("自连返回 null", () => {
    const a = makeNode("terminal");
    load([a]);
    expect(state().addEdge(a.id, a.id)).toBeNull();
  });

  it("重复（含反向）返回 null", () => {
    const a = makeNode("terminal");
    const b = makeNode("terminal");
    load([a, b]);
    state().addEdge(a.id, b.id);
    expect(state().addEdge(a.id, b.id)).toBeNull();
    expect(state().addEdge(b.id, a.id)).toBeNull();
    expect(edges()).toHaveLength(1);
  });

  it("方向按用户拖的来，不再把便签强行换到源（§21）", () => {
    const terminal = makeNode("terminal");
    const sticky = makeNode("sticky");
    load([terminal, sticky]);
    state().addEdge(terminal.id, sticky.id);
    expect(edges()[0]).toMatchObject({
      source: terminal.id,
      target: sticky.id,
    });
  });

  it("未知节点返回 null", () => {
    const a = makeNode("terminal");
    load([a]);
    expect(state().addEdge(a.id, "ghost")).toBeNull();
  });
});

describe("removeEdges", () => {
  it("按 id 删除", () => {
    const a = makeNode("terminal");
    const b = makeNode("terminal");
    const link = edge(a.id, b.id);
    load([a, b], [link]);
    state().removeEdges([link.id]);
    expect(edges()).toEqual([]);
    expect(state().saveState).toBe("dirty");
  });

  it("不存在的 id 不换文档", () => {
    load([], []);
    const before = state().document;
    state().removeEdges(["ghost"]);
    expect(state().document).toBe(before);
  });
});

describe("setViewport", () => {
  it("不置 dirty", () => {
    load([makeNode("sticky")]);
    state().setViewport({ x: 40, y: -20, zoom: 0.5 });
    expect(state().document?.board.viewport).toEqual({
      x: 40,
      y: -20,
      zoom: 0.5,
    });
    expect(state().saveState).toBe("saved");
  });
});

/**
 * 撤销 / 重做（React Flow 计划 §2.7）。
 *
 * 换成 React Flow 之后撤销栈是自写的：一条记录只装这次改动碰过的实体，
 * 撤销只回放 `before` 里出现的那些。四条语义逐条钉在这里。
 */
describe("撤销 / 重做", () => {
  it("一次动作一条历史：新建 → 撤销 → 重做", () => {
    load([]);
    const id = state().addNode("sticky");
    expect(nodes()).toHaveLength(1);
    state().undo();
    expect(nodes()).toHaveLength(0);
    state().redo();
    expect(byId(id)).toBeDefined();
  });

  it("拖动一次一条：连着两次移动要按两下才回到原位", () => {
    const a = makeNode("sticky", { position: { x: 0, y: 0 } });
    load([a]);
    state().moveNodes([{ id: a.id, position: { x: 100, y: 0 } }]);
    state().moveNodes([{ id: a.id, position: { x: 200, y: 0 } }]);
    state().undo();
    expect(byId(a.id)?.position).toEqual({ x: 100, y: 0 });
    state().undo();
    expect(byId(a.id)?.position).toEqual({ x: 0, y: 0 });
  });

  it("删除可以撤销，节点与它的连线一起回来", () => {
    const a = makeNode("terminal");
    const b = makeNode("sticky");
    load([a, b], [edge(a.id, b.id)]);
    state().removeNodes([b.id]);
    expect(nodes()).toHaveLength(1);
    expect(edges()).toHaveLength(0);
    state().undo();
    expect(nodes()).toHaveLength(2);
    expect(edges()).toHaveLength(1);
  });

  it("远端灌入（`setDocument`）不进栈：⌘Z 撤不掉别人的画布", () => {
    const a = makeNode("sticky");
    load([a]);
    expect(state().undo).toBeTypeOf("function");
    // 刚 `setDocument` 过，栈是空的：撤销什么都不该发生。
    const before = state().document;
    state().undo();
    expect(state().document).toBe(before);
  });

  it("撤销不删远端在这期间新增的节点", () => {
    const a = makeNode("sticky");
    load([a]);
    state().moveNodes([{ id: a.id, position: { x: 60, y: 60 } }]);
    // 另一个窗口 / Agent 建了一个节点：直接灌进文档，不走动作。
    const remote = makeNode("terminal");
    useCanvasStore.setState({
      document: { ...state().document!, nodes: [...nodes(), remote] },
    });
    state().undo();
    expect(byId(a.id)?.position).toEqual({ x: 0, y: 0 });
    expect(byId(remote.id)).toBeDefined();
  });

  it("被远端删掉的实体撤销时复活为本地新建", () => {
    const a = makeNode("sticky");
    load([a]);
    state().updateNode(a.id, { title: "改过" });
    useCanvasStore.setState({
      document: { ...state().document!, nodes: [] },
    });
    state().undo();
    expect(byId(a.id)?.title).toBe("sticky");
  });

  it("合并会话：一段文字编辑只形成一条历史", async () => {
    const { beginCoalesce, endCoalesce } = await import("./canvas-store");
    const a = makeNode("sticky");
    load([a]);
    beginCoalesce("edit text");
    state().updateNode(a.id, { title: "一" });
    state().updateNode(a.id, { title: "一二" });
    state().updateNode(a.id, { title: "一二三" });
    endCoalesce();
    state().undo();
    expect(byId(a.id)?.title).toBe("sticky");
  });

  it("视口、最大化的 premaxRect 不进历史", () => {
    const a = makeNode("sticky");
    load([a]);
    state().setViewport({ x: 5, y: 5, zoom: 2 });
    state().undo();
    expect(state().document?.board.viewport).toEqual({ x: 5, y: 5, zoom: 2 });
  });

  it("换画布清栈：上一块板的补丁在这一块上没有意义", () => {
    const a = makeNode("sticky");
    load([a]);
    state().removeNodes([a.id]);
    load([makeNode("terminal")]);
    const before = state().document;
    state().undo();
    expect(state().document).toBe(before);
  });
});

describe("arrangeNodes", () => {
  it("按连线方向分列，组员不动", () => {
    const a = makeNode("terminal", { position: { x: 500, y: 500 } });
    const b = makeNode("terminal", { position: { x: 0, y: 0 } });
    const group = makeNode("group", { position: { x: 900, y: 900 } });
    const child = makeNode("sticky", {
      parentId: group.id,
      position: { x: 10, y: 10 },
    });
    load([a, b, group, child], [edge(a.id, b.id)]);

    state().arrangeNodes();

    expect(byId(a.id)?.position).toEqual({ x: 0, y: 0 });
    expect(byId(b.id)?.position.x).toBeGreaterThan(0);
    // 组员的坐标是相对组框的，Tidy 不碰
    expect(byId(child.id)?.position).toEqual({ x: 10, y: 10 });
    expect(state().saveState).toBe("dirty");
  });

  it("已经是整齐的就不换文档", () => {
    const a = makeNode("terminal", { position: { x: 0, y: 0 } });
    load([a]);
    const before = state().document;
    state().arrangeNodes();
    expect(state().document).toBe(before);
  });
});
