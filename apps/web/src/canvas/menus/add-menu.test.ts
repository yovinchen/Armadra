import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo, Position, SshHost, Workspace } from "@armadra/shared";

/**
 * 新建菜单（§13.3；React Flow 计划 F18 / §4.2 的 `add-menu` 行）。
 *
 * 换引擎后这里唯一变的是两项内容项的落点：「文字」建的是一条白板对象
 * （`whiteboard.items`，不进 `nodes` 表），「画框」建的是一个 `group`
 * 节点（进 `nodes` 表）。两者都不再经旧引擎的 editor，所以断言看的是
 * store 动作被调成什么样。
 *
 * `store/defaults.ts` 会把整棵节点渲染树拉进来，所以按 `canvas-store.test`
 * 的做法给 `nodes/registry` 一份最小替身。
 */
vi.mock("@/nodes/registry", () => {
  const meta = {
    labelKey: "node.sticky",
    icon: null,
    defaultSize: { width: 240, height: 200 },
    minSize: { width: 160, height: 120 },
    defaultColor: "#ffd60a",
    hasBridgeHandles: false,
  };
  const table = new Proxy({} as Record<string, typeof meta>, {
    get: () => meta,
    has: () => true,
  });
  return {
    NODE_META: table,
    nodeMeta: () => meta,
    DRAG_HANDLE_CLASS: "drag-handle",
    NODE_DRAG_HANDLE: ".drag-handle",
  };
});

const addNode = vi.fn(() => "node-1");
const setPanel = vi.fn();
type TestItem = {
  id: string;
  kind: string;
  x: number;
  y: number;
  text: string;
};
const addItems = vi.fn((items: TestItem[]) => items.map((item) => item.id));
const select = vi.fn();
const pickFilesForCanvas = vi.fn();
const openAutomationPanel = vi.fn();
const runCanvasCommand = vi.fn();

type TestNode = {
  id: string;
  type: string;
  title: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
};

const state = {
  addNode,
  setPanel,
  document: { nodes: [] as TestNode[] },
};

vi.mock("../../store/canvas-store", () => ({
  useCanvasStore: { getState: () => state },
}));
vi.mock("../whiteboard/store", () => ({
  addItems,
  select,
  createItemId: () => "item-1",
}));
vi.mock("../dnd/external-content", () => ({ pickFilesForCanvas }));
vi.mock("../../panels/automation/open", () => ({ openAutomationPanel }));
vi.mock("../commands", () => ({ runCanvasCommand }));

const { buildAddMenu, sshMenuItems } = await import("./add-menu");

const now = "2026-09-06T00:00:00.000Z";
const workspace: Workspace = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "alpha",
  rootPath: "/tmp/alpha",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: now,
  createdAt: now,
  updatedAt: now,
};

const claude: AgentInfo = {
  id: "claude",
  label: "Claude Code",
  color: "#d97757",
  launchCmd: "claude",
  promptMode: "argv",
  args: [],
  capabilities: ["hooks"],
  resolvedPath: "/usr/local/bin/claude",
  installed: true,
  clientRevision: 1,
};

/**
 * 菜单拿到的是**中心**锚点，不是左上角（`canvas/placement.ts`）。
 * 替身 registry 把所有类型的默认尺寸都给成 240×200，所以居中之后的左上角
 * 是 `{120-120, 80-100}`；「画框」自带 1040×720，另算。
 */
const position: Position = { x: 120, y: 80 };
const centered = { x: 0, y: -20 };
const framePosition = { x: -400, y: -280 };
const t = (key: string) => key;
const ctx = { addNode, position, workspace, agents: [claude] };

function itemById(
  id: string,
  agents: AgentInfo[] = [claude],
  hosts: SshHost[] = [],
) {
  const item = buildAddMenu(agents, t, hosts).find((entry) => entry.id === id);
  if (!item) throw new Error(`missing menu item: ${id}`);
  return item;
}

describe("buildAddMenu", () => {
  beforeEach(() => {
    for (const fn of [
      addNode,
      setPanel,
      addItems,
      select,
      pickFilesForCanvas,
      openAutomationPanel,
      runCanvasCommand,
    ])
      fn.mockClear();
    state.document = { nodes: [] };
  });

  it("按 §3.2 的顺序分组：终端 → Agent → 内容 → 画布动作", () => {
    const groups = buildAddMenu([claude], t).map((item) => item.group);
    expect(groups[0]).toBe("terminal");
    expect(groups[1]).toBe("agent");
    expect(groups.at(-1)).toBe("canvas");
    // 每个组只出现一段，不会被别的组打断（渲染时按 group 变化插分隔线）。
    expect(new Set(groups).size).toBe(
      groups.filter((group, index) => group !== groups[index - 1]).length,
    );
  });

  it("新建终端以右键那一点为中心", () => {
    itemById("add.terminal").run(ctx);
    expect(addNode).toHaveBeenCalledWith("terminal", { position: centered });
  });

  it("落点压住已有节点时让开", () => {
    state.document = {
      nodes: [
        {
          id: "n1",
          type: "terminal",
          title: "shell",
          position: centered,
          size: { width: 240, height: 200 },
        },
      ],
    };
    itemById("add.terminal").run(ctx);
    // 替身节点 240×200，所以要让 7 步（224px）才完全不压住。
    expect(addNode).toHaveBeenCalledWith("terminal", {
      position: { x: centered.x + 224, y: centered.y + 224 },
    });
  });

  it("Agent 项带品牌色，且用的是 CLI 自己的名字（不翻译）", () => {
    const item = itemById("add.agent.claude");
    expect(item.label).toBe("Claude Code");
    expect(item.color).toBe("#d97757");
  });

  it("探测不到可执行文件的 Agent 禁用而不隐藏", () => {
    const missing = { ...claude, resolvedPath: "", installed: false };
    const item = itemById("add.agent.claude", [missing]);
    expect(item.disabledReason?.({ ...ctx, agents: [missing] })).toBe(
      "add.notInstalled",
    );
  });

  it("SSH 组按设置里的主机数展开；一台都没有时整组不出现", () => {
    const host: SshHost = {
      id: "h1",
      name: "build-box",
      host: "10.0.0.2",
      port: 22,
      user: "root",
    };
    expect(sshMenuItems([], t)).toEqual([]);
    const menu = sshMenuItems([host], t);
    expect(menu).toHaveLength(1);
    menu[0]!.run(ctx);
    expect(addNode).toHaveBeenCalledWith("terminal", {
      position: centered,
      title: "build-box",
      data: { kind: "terminal", ssh: { hostId: "h1" } },
    });
  });

  it("便签走 `addNode`", () => {
    itemById("add.sticky").run(ctx);
    expect(addNode).toHaveBeenCalledWith("sticky", { position: centered });
  });

  it("文件管理器带上工作区根路径", () => {
    itemById("add.files").run(ctx);
    expect(addNode).toHaveBeenCalledWith("files", {
      position: centered,
      data: { kind: "files", path: "/tmp/alpha" },
    });
  });

  it("「打开文件…」开的是资源管理器抽屉，不建节点", () => {
    itemById("add.openFile").run(ctx);
    expect(setPanel).toHaveBeenCalledWith("explorer", "drawer");
    expect(addNode).not.toHaveBeenCalled();
  });

  it("「导入文件…」把落点交给外部内容处理器", () => {
    itemById("add.importFiles").run(ctx);
    expect(pickFilesForCanvas).toHaveBeenCalledWith(centered);
  });

  /** F18 / §2.2：文字是白板对象，不是节点——它不该出现在 `nodes` 表里。 */
  it("「文字」建一条 `wb.text` 白板对象并选中它", () => {
    itemById("add.text").run(ctx);
    expect(addNode).not.toHaveBeenCalled();
    const items = addItems.mock.calls[0]![0];
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("text");
    expect(items[0]!.text).toBe("");
    expect({ x: items[0]!.x, y: items[0]!.y }).toEqual(position);
    expect(select).toHaveBeenCalledWith(["item-1"]);
  });

  /** F05：「画框」= 分组节点，以锚点为中心摆下。 */
  it("「画框」建一个 `group` 节点", () => {
    itemById("add.frame").run(ctx);
    expect(addItems).not.toHaveBeenCalled();
    expect(addNode).toHaveBeenCalledWith("group", {
      position: framePosition,
      size: { width: 1040, height: 720 },
    });
  });

  it("浏览器走 `addNode`", () => {
    itemById("add.browser").run(ctx);
    expect(addNode).toHaveBeenCalledWith("browser", { position: centered });
  });

  it("定时计划开的是自动化页，不建空卡片", () => {
    itemById("add.automation").run(ctx);
    expect(openAutomationPanel).toHaveBeenCalledWith(null);
    expect(addNode).not.toHaveBeenCalled();
  });

  it("画布上没有终端时活动卡片禁用", () => {
    const item = itemById("add.agentActivity");
    expect(item.disabledReason?.(ctx)).toBe("add.noTerminal");
    state.document = {
      nodes: [
        {
          id: "n1",
          type: "terminal",
          title: "shell",
          position: { x: 900, y: 900 },
          size: { width: 240, height: 200 },
        },
      ],
    };
    expect(item.disabledReason?.(ctx)).toBeNull();
    item.run(ctx);
    expect(addNode).toHaveBeenCalledWith("agentActivity", {
      position: centered,
      title: "shell",
      data: { kind: "agentActivity", sourceNodeId: "n1" },
    });
  });

  it("画布动作三项只发命令，不碰 store", () => {
    for (const id of ["canvas.selectAll", "canvas.fitView", "canvas.tidy"]) {
      itemById(id).run(ctx);
    }
    expect(runCanvasCommand.mock.calls.map(([id]) => id)).toEqual([
      "canvas.selectAll",
      "canvas.fitView",
      "canvas.tidy",
    ]);
    expect(addNode).not.toHaveBeenCalled();
  });

  it("只有真的绑了键的项才带 `shortcut`", () => {
    const shortcuts = Object.fromEntries(
      buildAddMenu([claude], t).map((item) => [item.id, item.shortcut ?? null]),
    );
    expect(shortcuts["add.terminal"]).toBe("canvas.newTerminal");
    expect(shortcuts["canvas.tidy"]).toBe("canvas.tidy");
    expect(shortcuts["add.text"]).toBeNull();
    expect(shortcuts["add.frame"]).toBeNull();
  });
});
