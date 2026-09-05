import { describe, expect, it } from "vitest";
import {
  RETIRED_SHAPE_TYPES,
  activeShapeUtils,
  isRetiredShapeType,
  registerRetiredShapes,
} from "./retired-shapes";

type Handler = (shape: { id: string; type: string }, source: string) => void;

function fakeEditor() {
  const handlers: Handler[] = [];
  const shapes = new Map<string, { id: string; type: string }>();
  const deleted: string[][] = [];
  const editor = {
    sideEffects: {
      registerAfterCreateHandler: (type: string, fn: Handler) => {
        expect(type).toBe("shape");
        handlers.push(fn);
        return () => {
          handlers.splice(handlers.indexOf(fn), 1);
        };
      },
    },
    getShape: (id: string) => shapes.get(id),
    run: (fn: () => void) => fn(),
    deleteShapes: (ids: string[]) => {
      deleted.push(ids);
      for (const id of ids) shapes.delete(id);
    },
    create(shape: { id: string; type: string }, source = "user") {
      shapes.set(shape.id, shape);
      for (const handler of handlers) handler(shape, source);
    },
  };
  return { editor, shapes, deleted };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("retired shapes", () => {
  it("仅停用bookmark/embed/video，原生note可引用", () => {
    expect([...RETIRED_SHAPE_TYPES]).toEqual(["bookmark", "embed", "video"]);
    expect(isRetiredShapeType("note")).toBe(false);
    expect(isRetiredShapeType("geo")).toBe(false);
  });

  it("从 shape util 清单里滤掉停用的四种，留下的原样", () => {
    const utils = [
      { type: "geo" },
      { type: "note" },
      { type: "draw" },
      { type: "video" },
      { type: "image" },
    ];
    expect(activeShapeUtils(utils).map((util) => util.type)).toEqual([
      "geo",
      "note",
      "draw",
      "image",
    ]);
  });

  it("用户新建的停用 shape 会被撤掉，其它 shape 不动", async () => {
    const { editor, shapes, deleted } = fakeEditor();
    const off = registerRetiredShapes(editor as never);

    editor.create({ id: "shape:note", type: "note" });
    editor.create({ id: "shape:video", type: "video" });
    editor.create({ id: "shape:geo", type: "geo" });
    await flush();

    expect(deleted).toEqual([["shape:video"]]);
    expect([...shapes.keys()]).toEqual(["shape:note", "shape:geo"]);
    off();
  });

  it("远端/加载来的记录不碰（老看板里的便签照样读得出来）", async () => {
    const { editor, shapes, deleted } = fakeEditor();
    const off = registerRetiredShapes(editor as never);

    editor.create({ id: "shape:note", type: "note" }, "remote");
    await flush();

    expect(deleted).toEqual([]);
    expect([...shapes.keys()]).toEqual(["shape:note"]);
    off();
  });

  it("注销之后不再删东西", async () => {
    const { editor, deleted } = fakeEditor();
    const off = registerRetiredShapes(editor as never);
    off();

    editor.create({ id: "shape:note", type: "note" });
    await flush();

    expect(deleted).toEqual([]);
  });
});
