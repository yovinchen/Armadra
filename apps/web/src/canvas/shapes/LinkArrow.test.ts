import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor, TLArrowBinding, TLArrowShape, TLShapeId } from "tldraw";

/** tldraw 在模块加载时就读 `matchMedia`（见 `ArmadraShapeUtil.test.ts`）。 */
vi.hoisted(() => {
  if (typeof window !== "undefined" && !window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }
});

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/app/preferences-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  t: (key: string) => key,
}));

/** 只为了拿默认尺寸；节点体不该被拉进纯函数单测。 */
const nodeMetaStub = {
  labelKey: "node.sticky",
  defaultSize: { width: 240, height: 200 },
  minSize: { width: 160, height: 120 },
  defaultColor: "#0a84ff",
  hasBridgeHandles: false,
};
vi.mock("../../nodes/registry", () => ({
  NODE_META: new Proxy({}, { get: () => nodeMetaStub }),
  nodeMeta: () => nodeMetaStub,
}));

import { linkToEdge } from "../sync/derive";
import {
  beginHandleLink,
  registerLinkArrow,
  stabilizeNodeBinding,
} from "./LinkArrow";
import { nodeArrowPreview } from "./NodeArrowShapeUtil";
import { linkView } from "./LinkShapeUtil";
import { toShapeId } from "./armadra-shape";
import { LinkBindingUtil } from "./LinkBindingUtil";
import { isLinkShape, type LinkShape } from "./link-shape";

const A = "019ff7d1-0d12-7421-833d-2c5e8d64ed01";
const B = "019ff7d1-0d12-7421-833d-2c5e8d64ed02";
const C = "019ff7d1-0d12-7421-833d-2c5e8d64ed03";
const BOARD = "019ff7d1-0d12-7421-833d-2c5e8d64ed00";

type Rec = Record<string, unknown>;

/**
 * `registerLinkArrow` 只用到 editor 的十来个方法，所以这里手搓一个够用的
 * 假 editor：真 `<Tldraw>` 挂不进 jsdom（画布、rAF、字体全缺）。
 */
class FakeEditor {
  shapes = new Map<string, Rec>();
  bindings: Rec[] = [];
  path = "select.idle";
  bails = 0;
  handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

  sideEffects = {
    registerBeforeCreateHandler: (type: string, fn: never) =>
      this.on(`before-create:${type}`, fn),
    registerAfterCreateHandler: (type: string, fn: never) =>
      this.on(`create:${type}`, fn),
    registerAfterChangeHandler: (type: string, fn: never) =>
      this.on(`change:${type}`, fn),
    registerAfterDeleteHandler: (type: string, fn: never) =>
      this.on(`delete:${type}`, fn),
    registerBeforeChangeHandler: (type: string, fn: never) =>
      this.on(`before-change:${type}`, fn),
  };

  private on(key: string, fn: unknown): () => void {
    const list = (this.handlers[key] ??= []);
    list.push(fn as (...args: unknown[]) => void);
    return () => {
      const index = list.indexOf(fn as (...args: unknown[]) => void);
      if (index >= 0) list.splice(index, 1);
    };
  }

  private emit(key: string, ...args: unknown[]): void {
    for (const fn of this.handlers[key] ?? []) fn(...args);
  }

  getPath(): string {
    return this.path;
  }

  getShape(id: string): Rec | undefined {
    return this.shapes.get(id);
  }

  getShapePageBounds(id: string) {
    if (!this.shapes.has(id)) return undefined;
    const x = id === toShapeId(A) ? 40 : 740;
    return {
      x,
      y: 80,
      width: 400,
      height: 300,
      center: { x: x + 200, y: 230 },
    };
  }

  getCurrentPageShapes(): Rec[] {
    return [...this.shapes.values()];
  }

  getBindingsFromShape(id: string): Rec[] {
    return this.bindings.filter((binding) => binding.fromId === id);
  }

  getCurrentPageId(): string {
    return "page:page";
  }

  createShape(shape: Rec): void {
    this.shapes.set(shape.id as string, shape);
  }

  createBinding(binding: Rec): void {
    this.bindings.push(binding);
  }

  sendToBack(): void {
    /* 顺序在假 editor 里没有意义 */
  }

  run(fn: () => void): void {
    fn();
  }

  updateShape(patch: Rec): void {
    const shape = this.shapes.get(patch.id as string);
    if (!shape) return;
    this.shapes.set(patch.id as string, {
      ...shape,
      ...patch,
      props: { ...(shape.props as Rec), ...((patch.props as Rec) ?? {}) },
    });
  }

  deleteShape(id: string): void {
    this.shapes.delete(id);
    this.bindings = this.bindings.filter((binding) => binding.fromId !== id);
  }

  bail(): void {
    this.bails += 1;
  }

  /* --------------------------- 测试用的动作 --------------------------- */

  addNode(id: string, nodeType: string, color = "#0a84ff"): void {
    this.shapes.set(toShapeId(id), {
      id: toShapeId(id),
      type: "armadra",
      typeName: "shape",
      meta: {},
      props: { nodeType, color },
    });
  }

  createArrow(id: string): void {
    const shape = {
      id,
      type: "arrow",
      typeName: "shape",
      meta: {},
      props: { arrowheadStart: "none", arrowheadEnd: "arrow", color: "black" },
    };
    this.shapes.set(id, shape);
    this.emit("create:shape", shape, "user");
  }

  bind(arrowId: string, terminal: "start" | "end", nodeId: string): void {
    this.bindShape(arrowId, terminal, toShapeId(nodeId));
  }

  /** 绑到任意 shape（内容链接的白板那一端不是节点）。 */
  bindShape(arrowId: string, terminal: "start" | "end", toId: string): void {
    let binding: Rec = {
      id: `binding:${arrowId}-${terminal}`,
      typeName: "binding",
      type: "arrow",
      fromId: arrowId,
      toId,
      props: {
        terminal,
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isPrecise: false,
        isExact: false,
      },
    };
    for (const fn of this.handlers["before-create:binding"] ?? []) {
      binding = (fn(binding, "user") as unknown as Rec) ?? binding;
    }
    this.bindings.push(binding);
    this.emit("create:binding", binding, "user");
  }

  /** 一个白板原生 shape（文字 / 手绘 / 画框…）。 */
  addBoardShape(id: string, type: string): void {
    this.shapes.set(id, {
      id,
      type,
      typeName: "shape",
      parentId: "page:page",
      meta: {},
      props: {},
    });
  }

  unbind(arrowId: string, terminal: "start" | "end"): void {
    const index = this.bindings.findIndex(
      (binding) =>
        binding.fromId === arrowId &&
        (binding.props as Rec).terminal === terminal,
    );
    if (index < 0) return;
    const [binding] = this.bindings.splice(index, 1);
    this.emit("delete:binding", binding, "user");
  }

  arrow(id: string): Rec | undefined {
    return this.shapes.get(id);
  }

  /** 画布上唯一的那条连线（换形之后 arrow 已经不在了）。 */
  links(): LinkShape[] {
    return [...this.shapes.values()].filter((shape) =>
      isLinkShape(shape as never),
    ) as unknown as LinkShape[];
  }

  armadra(id: string): Rec {
    return this.shapes.get(id) as Rec;
  }
}

function meta(shape: Rec | undefined): Rec {
  return ((shape?.meta as Rec)?.armadra ?? {}) as Rec;
}

/** 松手 = 一次交互结束；微任务 + 宏任务都跑完再断言。 */
async function release(editor: FakeEditor): Promise<void> {
  editor.path = "select.idle";
  window.dispatchEvent(new Event("pointerup"));
  await new Promise((resolve) => setTimeout(resolve, 5));
}

let editor: FakeEditor;
let off: () => void;

beforeEach(() => {
  toast.error.mockClear();
  editor = new FakeEditor();
  editor.addNode(A, "sticky", "#ffd60a");
  editor.addNode(B, "terminal");
  editor.addNode(C, "terminal");
  off = registerLinkArrow(editor as unknown as Editor);
});

afterEach(() => {
  off();
});

describe("registerLinkArrow · 换形", () => {
  it("preserves the chosen left port even when the native tool initially snaps to centre", () => {
    beginHandleLink("left");
    editor.path = "select.dragging_handle";
    editor.createArrow("shape:left-port");
    editor.bind("shape:left-port", "start", A);
    expect(editor.getBindingsFromShape("shape:left-port")[0]?.props).toEqual(
      expect.objectContaining({
        normalizedAnchor: { x: 0, y: 0.5 },
        isPrecise: true,
        isExact: true,
      }),
    );
  });

  it("anchors ports before the first drag frame and preserves the preview geometry on release", async () => {
    editor.path = "select.dragging_handle";
    editor.createArrow("shape:preview");
    editor.bind("shape:preview", "start", A);
    editor.bind("shape:preview", "end", B);
    const bindings = editor.getBindingsFromShape(
      "shape:preview",
    ) as unknown as TLArrowBinding[];
    expect(bindings.map((binding) => binding.props)).toEqual([
      expect.objectContaining({
        normalizedAnchor: { x: 1, y: 0.5 },
        isPrecise: true,
        isExact: true,
      }),
      expect.objectContaining({
        normalizedAnchor: { x: 0, y: 0.5 },
        isPrecise: true,
        isExact: true,
      }),
    ]);
    const preview = nodeArrowPreview(
      editor as unknown as Editor,
      editor.arrow("shape:preview") as unknown as TLArrowShape,
    )!;
    const before = linkView(editor as unknown as Editor, preview);
    expect(before?.curve.sourceX).toBe(440);
    expect(before?.curve.targetX).toBe(740);
    await release(editor);
    expect(linkView(editor as unknown as Editor, editor.links()[0]!)).toEqual(
      before,
    );
  });

  it("does not turn native content arrows into a node-link preview", () => {
    editor.path = "select.dragging_handle";
    editor.addBoardShape("shape:note", "geo");
    editor.createArrow("shape:content");
    editor.bind("shape:content", "start", A);
    editor.bindShape("shape:content", "end", "shape:note");
    const bindings = editor.getBindingsFromShape(
      "shape:content",
    ) as unknown as TLArrowBinding[];
    expect(
      stabilizeNodeBinding(editor as unknown as Editor, bindings[1]!),
    ).toBe(bindings[1]);
    expect(bindings[1]?.props.isPrecise).toBe(false);
    expect(
      nodeArrowPreview(
        editor as unknown as Editor,
        editor.arrow("shape:content") as unknown as TLArrowShape,
      ),
    ).toBeNull();
  });

  it("两端绑到节点的箭头被换成 link shape + 两条 binding", async () => {
    editor.path = "select.dragging_handle";
    editor.createArrow("shape:rnd1");
    editor.bind("shape:rnd1", "start", A);
    editor.bind("shape:rnd1", "end", B);
    await release(editor);

    // 原生箭头没了（它画出来是被边框裁掉的直线）。
    expect(editor.arrow("shape:rnd1")).toBeUndefined();

    const links = editor.links();
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.props.edgeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(link.id).toBe(`shape:link-${link.props.edgeId}`);
    expect(link.props.from).toBe(toShapeId(A));
    expect(link.props.to).toBe(toShapeId(B));
    expect(link.x).toBe(0);
    expect(link.y).toBe(0);

    // 两端各一条 link binding。
    const bindings = editor.getBindingsFromShape(link.id);
    expect(bindings.map((item) => item.type)).toEqual(["link", "link"]);
    expect(bindings.map((item) => (item.props as Rec).terminal)).toEqual([
      "start",
      "end",
    ]);

    // 派生出来的边就是这条 link（往返恒等）。
    const edge = linkToEdge(link, BOARD);
    expect(edge).not.toBeNull();
    expect(edge!.id).toBe(link.props.edgeId);
    expect(edge!.source).toBe(A);
    expect(edge!.target).toBe(B);
  });
});

describe("registerLinkArrow · 合法性", () => {
  it("自连被拒，箭头删掉并提示一次", async () => {
    editor.path = "select.dragging_handle";
    editor.createArrow("shape:self");
    editor.bind("shape:self", "start", A);
    editor.bind("shape:self", "end", A);
    await release(editor);

    expect(editor.arrow("shape:self")).toBeUndefined();
    expect(editor.links()).toHaveLength(0);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("edge.selfLink", {
      id: "armadra-edge-invalid",
    });
    // 回滚而不是「删一次」：被拒的线不进撤销栈。
    expect(editor.bails).toBe(1);
  });

  it("同一对重复连被拒，反方向也算重复", async () => {
    editor.path = "select.dragging_handle";
    editor.createArrow("shape:one");
    editor.bind("shape:one", "start", A);
    editor.bind("shape:one", "end", B);
    await release(editor);
    expect(editor.links()).toHaveLength(1);

    editor.path = "select.dragging_handle";
    editor.createArrow("shape:two");
    editor.bind("shape:two", "start", B);
    editor.bind("shape:two", "end", A);
    await release(editor);

    expect(editor.arrow("shape:two")).toBeUndefined();
    // 重复的那条没有变成第二条线。
    expect(editor.links()).toHaveLength(1);
    expect(toast.error).toHaveBeenCalledWith("edge.duplicate", {
      id: "armadra-edge-invalid",
    });
  });

  it("拖动过程中的中间态不判定（起笔时指针还在起点节点上）", async () => {
    editor.path = "select.dragging_handle";
    editor.createArrow("shape:mid");
    editor.bind("shape:mid", "start", A);
    editor.bind("shape:mid", "end", A);
    // 还没松手：一次微任务过去也不该动它。
    await Promise.resolve();
    expect(editor.arrow("shape:mid")).toBeDefined();

    // 拖到别的节点上再松手 —— 这才是用户的意图。
    editor.unbind("shape:mid", "end");
    editor.bind("shape:mid", "end", B);
    await release(editor);
    expect(editor.links()).toHaveLength(1);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("registerLinkArrow · 内容链接", () => {
  it("一端节点、一端白板 shape 的箭头留成 arrow，写一次方向与颜色", async () => {
    editor.addBoardShape("shape:txt", "text");
    editor.path = "select.dragging_handle";
    editor.createArrow("shape:content");
    editor.bindShape("shape:content", "start", "shape:txt");
    editor.bind("shape:content", "end", B);
    await release(editor);

    const arrow = editor.arrow("shape:content");
    expect(arrow).toBeDefined();
    // 换形只发生在两端都是节点时；内容链接仍然是原生 arrow。
    expect(editor.links()).toHaveLength(0);
    expect((arrow!.props as Rec).color).toBe("blue");
    // 箭头指向节点（节点在 end 这一端）。
    expect((arrow!.props as Rec).arrowheadEnd).toBe("arrow");
    expect((arrow!.props as Rec).arrowheadStart).toBe("none");
    expect(meta(arrow).contentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(meta(arrow).styled).toBe(true);
  });

  it("节点在起点时箭头反过来指；手改过样式之后不再被覆盖", async () => {
    editor.addBoardShape("shape:ink", "draw");
    editor.path = "select.dragging_handle";
    editor.createArrow("shape:c2");
    editor.bind("shape:c2", "start", B);
    editor.bindShape("shape:c2", "end", "shape:ink");
    await release(editor);

    expect((editor.arrow("shape:c2")!.props as Rec).arrowheadStart).toBe(
      "arrow",
    );
    const contentId = meta(editor.arrow("shape:c2")).contentId;

    // 用户手改成红色，再动一次 binding：颜色不该被写回蓝色，id 也不该换。
    editor.updateShape({ id: "shape:c2", props: { color: "red" } });
    editor.unbind("shape:c2", "end");
    editor.bindShape("shape:c2", "end", "shape:ink");
    await release(editor);
    expect((editor.arrow("shape:c2")!.props as Rec).color).toBe("red");
    expect(meta(editor.arrow("shape:c2")).contentId).toBe(contentId);
  });
});

describe("registerLinkArrow · 把手与级联", () => {
  it("从把手起笔、末端一个 shape 都没绑到 → 删掉", async () => {
    beginHandleLink();
    editor.path = "select.dragging_handle";
    editor.createArrow("shape:loose");
    editor.bind("shape:loose", "start", A);
    await release(editor);

    expect(editor.arrow("shape:loose")).toBeUndefined();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("从把手起笔、末端绑到白板 shape → 留着（内容链接，§6.3）", async () => {
    editor.addBoardShape("shape:geo1", "geo");
    beginHandleLink();
    editor.path = "select.dragging_handle";
    editor.createArrow("shape:toboard");
    editor.bind("shape:toboard", "start", A);
    editor.bindShape("shape:toboard", "end", "shape:geo1");
    await release(editor);

    expect(editor.arrow("shape:toboard")).toBeDefined();
    expect(meta(editor.arrow("shape:toboard")).contentId).toBeTruthy();
  });

  it("从箭头工具起笔的白板箭头留着", async () => {
    editor.path = "arrow.pointing";
    editor.createArrow("shape:free");
    await release(editor);
    expect(editor.arrow("shape:free")).toBeDefined();
  });

  it("节点被删 → link binding 的 `onBeforeDeleteToShape` 把线删掉", async () => {
    editor.path = "select.dragging_handle";
    editor.createArrow("shape:edge");
    editor.bind("shape:edge", "start", A);
    editor.bind("shape:edge", "end", B);
    await release(editor);
    const link = editor.links()[0]!;

    // 级联归 `LinkBindingUtil`（tldraw 删节点时会调它），这里直接验它。
    const util = new LinkBindingUtil(editor as unknown as Editor);
    util.onBeforeDeleteToShape({
      binding: editor.getBindingsFromShape(link.id)[1] as never,
      shape: editor.armadra(toShapeId(B)) as never,
    });
    expect(editor.links()).toHaveLength(0);
  });
});
