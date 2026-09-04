import { describe, expect, it, vi } from "vitest";
import type { Editor, TLShape, TLShapeId, TLShapePartial } from "tldraw";

// The layout suite needs no terminal, Monaco or canvas renderer.
vi.mock("../nodes/registry", () => ({ NODE_META: {}, nodeMeta: () => ({}) }));

import {
  arrangeEditorShapes,
  editorTidyUpdates,
  visiblePageBounds,
} from "./tidy-editor";
import type { Box } from "./geometry";

const PAGE = "page:test";
type RecordShape = TLShape & {
  box: Box;
  hidden?: boolean;
  noLayout?: boolean;
  clipped?: boolean;
};

function shape(
  id: string,
  type = "geo",
  options: {
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    parent?: string;
    locked?: boolean;
    hidden?: boolean;
    noLayout?: boolean;
    clipped?: boolean;
    offsetX?: number;
    offsetY?: number;
    from?: string;
    to?: string;
  } = {},
): RecordShape {
  const x = options.x ?? 0;
  const y = options.y ?? 0;
  return {
    id: `shape:${id}`,
    type,
    parentId: options.parent ? `shape:${options.parent}` : PAGE,
    x,
    y,
    opacity: 1,
    isLocked: options.locked ?? false,
    hidden: options.hidden,
    noLayout: options.noLayout,
    clipped: options.clipped,
    props: { from: `shape:${options.from}`, to: `shape:${options.to}` },
    box: {
      x: options.offsetX ?? 0,
      y: options.offsetY ?? 0,
      width: options.w ?? 120,
      height: options.h ?? 80,
    },
  } as unknown as RecordShape;
}

class Scene {
  shapes: RecordShape[];
  bindings: { fromId: string; toId: string; props: { terminal: string } }[] =
    [];
  marks = 0;
  batches = 0;
  readonly = false;
  before: RecordShape[] = [];
  // Selection intentionally is not queried by the global command.
  getSelectedShapes = vi.fn(() => [this.shapes[0]]);

  constructor(...shapes: RecordShape[]) {
    this.shapes = shapes;
  }
  getCurrentPageShapes() {
    return this.shapes;
  }
  getCurrentPageId() {
    return PAGE;
  }
  getIsReadonly() {
    return this.readonly;
  }
  getShape(id: string) {
    return this.shapes.find((shape) => shape.id === id);
  }
  getBindingsFromShape(id: string) {
    return this.bindings.filter((binding) => binding.fromId === id);
  }
  getShapeUtil(shape: RecordShape) {
    return { canBeLaidOut: () => !shape.noLayout && shape.type !== "link" };
  }
  isShapeHidden(shape: RecordShape): boolean {
    const parent = this.getShape(shape.parentId);
    return !!shape.hidden || (!!parent && this.isShapeHidden(parent));
  }
  isShapeOrAncestorLocked(shape: RecordShape): boolean {
    const parent = this.getShape(shape.parentId);
    return shape.isLocked || (!!parent && this.isShapeOrAncestorLocked(parent));
  }
  getShapePageBounds(id: string): Box | undefined {
    const shape = this.getShape(id);
    if (!shape) return;
    let x = shape.x + shape.box.x;
    let y = shape.y + shape.box.y;
    let parent = this.getShape(shape.parentId);
    while (parent) {
      x += parent.x;
      y += parent.y;
      parent = this.getShape(parent.parentId);
    }
    return { ...shape.box, x, y };
  }
  getShapeMaskedPageBounds(id: string) {
    return this.getShape(id)?.clipped ? undefined : this.getShapePageBounds(id);
  }
  markHistoryStoppingPoint() {
    this.marks++;
    this.before = structuredClone(this.shapes);
  }
  run(fn: () => void) {
    this.batches++;
    fn();
  }
  updateShapes(updates: TLShapePartial[]) {
    for (const update of updates) {
      const shape = this.getShape(update.id)!;
      if (this.isShapeOrAncestorLocked(shape)) continue;
      Object.assign(shape, update);
    }
  }
  undo() {
    this.shapes = this.before;
  }
  editor() {
    return this as unknown as Editor;
  }
  bind(arrow: string, from: string, to: string) {
    this.bindings.push(
      {
        fromId: `shape:${arrow}`,
        toId: `shape:${from}`,
        props: { terminal: "start" },
      },
      {
        fromId: `shape:${arrow}`,
        toId: `shape:${to}`,
        props: { terminal: "end" },
      },
    );
  }
}

function overlaps(a: Box, b: Box) {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

describe("whole-canvas tidy", () => {
  it("includes native content, custom nodes, legacy shapes and offscreen objects in one undo step", () => {
    const types = [
      "armadra",
      "text",
      "geo",
      "image",
      "draw",
      "highlight",
      "line",
      "arrow",
      "note",
      "bookmark",
      "embed",
      "video",
    ];
    const scene = new Scene(
      ...types.map((type, i) =>
        shape(String(i), type, { x: i === 11 ? 30_000 : 200, y: 200 }),
      ),
    );
    const original = structuredClone(scene.shapes);
    arrangeEditorShapes(scene.editor(), { aspect: 2 });
    expect(scene.marks).toBe(1);
    expect(scene.batches).toBe(1);
    expect(scene.getSelectedShapes).not.toHaveBeenCalled();
    const bounds = scene.shapes.map(
      (shape) => scene.getShapePageBounds(shape.id)!,
    );
    expect(Math.max(...bounds.map((box) => box.x))).toBeLessThan(3000);
    for (let i = 0; i < bounds.length; i++) {
      for (let j = i + 1; j < bounds.length; j++)
        expect(overlaps(bounds[i]!, bounds[j]!)).toBe(false);
    }
    arrangeEditorShapes(scene.editor(), { aspect: 2 });
    expect(scene.marks).toBe(1);
    scene.undo();
    expect(scene.shapes).toEqual(original);
  });

  it("moves ordinary frames and native groups once while preserving all descendants", () => {
    const scene = new Scene(
      shape("frame", "frame", { x: 700, y: 700, w: 500, h: 350 }),
      shape("group", "group", { x: 710, y: 710, w: 280, h: 200 }),
      shape("terminal", "armadra", { x: 30, y: 50, parent: "frame" }),
      shape("nested", "group", { x: 20, y: 20, parent: "group" }),
      shape("image", "image", { x: 15, y: 15, parent: "nested" }),
    );
    const children = structuredClone(scene.shapes.slice(2));
    const updates = editorTidyUpdates(scene.editor());
    expect(
      updates.every((update) =>
        ["shape:frame", "shape:group"].includes(update.id),
      ),
    ).toBe(true);
    arrangeEditorShapes(scene.editor());
    expect(scene.shapes.slice(2)).toEqual(children);
    expect(
      overlaps(
        scene.getShapePageBounds("shape:frame")!,
        scene.getShapePageBounds("shape:group")!,
      ),
    ).toBe(false);
  });

  it("preserves locked and hidden roots, avoids fixed objects, and does not move locked descendants independently", () => {
    const scene = new Scene(
      shape("locked", "frame", { locked: true, w: 360, h: 240 }),
      shape("child", "armadra", { parent: "locked", x: 20, y: 30 }),
      shape("a", "armadra"),
      shape("b", "text"),
      shape("hidden", "image", { hidden: true, x: -10_000, y: -10_000 }),
      shape("fixed", "geo", { noLayout: true, x: 600, y: 100 }),
    );
    const before = structuredClone(
      scene.shapes.filter((shape) =>
        ["shape:locked", "shape:child", "shape:hidden", "shape:fixed"].includes(
          shape.id,
        ),
      ),
    );
    arrangeEditorShapes(scene.editor());
    expect(
      scene.shapes.filter((shape) => before.some((old) => old.id === shape.id)),
    ).toEqual(before);
    for (const id of ["shape:a", "shape:b"])
      expect(
        overlaps(
          scene.getShapePageBounds(id)!,
          scene.getShapePageBounds("shape:locked")!,
        ),
      ).toBe(false);
  });

  it("maps child-to-child links onto their root containers and lets bound arrows follow their endpoints", () => {
    const scene = new Scene(
      shape("target", "frame", { x: 0 }),
      shape("source", "group", { x: 500 }),
      shape("a", "armadra", { parent: "source" }),
      shape("b", "text", { parent: "target" }),
      shape("link", "link", { from: "a", to: "b" }),
      shape("arrow", "arrow"),
    );
    scene.bind("arrow", "a", "b");
    const updates = editorTidyUpdates(scene.editor());
    expect(
      updates.some((update) =>
        ["shape:link", "shape:arrow"].includes(update.id),
      ),
    ).toBe(false);
    arrangeEditorShapes(scene.editor());
    expect(scene.getShape("shape:source")!.x).toBeLessThan(
      scene.getShape("shape:target")!.x,
    );
    expect(scene.bindings).toHaveLength(2);
  });

  it("translates rotated/freehand bounds without replacing the shape origin", () => {
    const scene = new Scene(
      shape("first", "text"),
      shape("rotated", "geo", { x: 30, y: 20, offsetX: -30, offsetY: -20 }),
    );
    arrangeEditorShapes(scene.editor());
    const rotated = scene.getShape("shape:rotated")!;
    const bounds = scene.getShapePageBounds(rotated.id)!;
    expect(rotated.x - bounds.x).toBe(30);
    expect(rotated.y - bounds.y).toBe(20);
    expect(overlaps(bounds, scene.getShapePageBounds("shape:first")!)).toBe(
      false,
    );
  });

  it("does nothing for a readonly editor or an already tidy page", () => {
    const scene = new Scene(shape("a"));
    arrangeEditorShapes(scene.editor());
    expect(scene.marks).toBe(0);
    scene.shapes.push(shape("b"));
    scene.readonly = true;
    arrangeEditorShapes(scene.editor());
    expect(scene.marks).toBe(0);
  });
});

describe("visible fit bounds", () => {
  it("includes native content while ignoring hidden ancestors and fully clipped children", () => {
    const scene = new Scene(
      shape("node", "armadra", { x: 100, y: 100 }),
      shape("image", "image", { x: 500, y: 300 }),
      shape("hidden", "frame", { x: -50_000, hidden: true }),
      shape("hidden-child", "text", { parent: "hidden" }),
      shape("clipped", "draw", { x: 50_000, clipped: true }),
      { ...shape("transparent", "frame", { x: 70_000 }), opacity: 0 },
      shape("transparent-child", "geo", { parent: "transparent" }),
    );
    expect(visiblePageBounds(scene.editor())).toEqual({
      x: 100,
      y: 100,
      width: 520,
      height: 280,
    });
  });
});
