import { beforeEach, describe, expect, it } from "vitest";
import {
  DRAG_MIME,
  clampTitle,
  clearDragPayload,
  currentDragPayload,
  formatBytes,
  formatOf,
  guessLanguage,
  guessMimeType,
  hasOsFiles,
  isImagePath,
  nodeDataForPayload,
  noteDataFromText,
  parseDragPayload,
  readDragPayload,
  setDragPayload,
  type DragPayload,
} from "./payload";

/** Minimal stand-in: jsdom has no `DataTransfer` constructor. */
function transfer(initial: Record<string, string> = {}): DataTransfer {
  const store = new Map(Object.entries(initial));
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
    get types() {
      return [...store.keys()];
    },
    effectAllowed: "none",
  } as unknown as DataTransfer;
}

const t = (key: string, values: Record<string, string | number> = {}) =>
  Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    key,
  );

const context = { rootPath: "/repo", t, label: () => "任务" };

beforeEach(() => clearDragPayload());

describe("setDragPayload", () => {
  it("writes both MIME types and remembers the payload for dragover", () => {
    const payload: DragPayload = { kind: "node", type: "agent" };
    const dataTransfer = transfer();
    setDragPayload({ dataTransfer }, payload);

    expect(JSON.parse(dataTransfer.getData(DRAG_MIME))).toEqual(payload);
    expect(JSON.parse(dataTransfer.getData("text/plain"))).toEqual(payload);
    // `dragover` cannot read the DataTransfer, hence the module ref.
    expect(currentDragPayload()).toEqual(payload);
    clearDragPayload();
    expect(currentDragPayload()).toBeNull();
  });

  it("still records the payload when the transfer is read-only", () => {
    const readOnly = {
      setData: () => {
        throw new Error("read-only");
      },
      getData: () => "",
      types: [],
    } as unknown as DataTransfer;
    setDragPayload({ dataTransfer: readOnly }, { kind: "node", type: "note" });
    expect(currentDragPayload()).toEqual({ kind: "node", type: "note" });
  });
});

describe("readDragPayload", () => {
  it("prefers the private MIME type and falls back to text/plain", () => {
    const file = JSON.stringify({
      kind: "file",
      path: "src/a.ts",
      name: "a.ts",
      size: 12,
    });
    expect(readDragPayload(transfer({ [DRAG_MIME]: file }))?.kind).toBe("file");
    expect(readDragPayload(transfer({ "text/plain": file }))?.kind).toBe(
      "file",
    );
    expect(readDragPayload(null)).toBeNull();
  });

  it("rejects junk instead of throwing", () => {
    expect(parseDragPayload("")).toBeNull();
    expect(parseDragPayload("not json")).toBeNull();
    expect(parseDragPayload("[1,2]")).toBeNull();
    expect(parseDragPayload('{"kind":"file"}')).toBeNull();
    expect(parseDragPayload('{"kind":"node","type":"nope"}')).toBeNull();
    expect(parseDragPayload('{"kind":"mystery","path":"x"}')).toBeNull();
  });

  it("fills in the name and mime type from the path", () => {
    const payload = parseDragPayload('{"kind":"image","path":"a/logo.png"}');
    expect(payload).toEqual({
      kind: "image",
      path: "a/logo.png",
      name: "logo.png",
      mimeType: "image/png",
    });
  });
});

describe("hasOsFiles", () => {
  it("detects an OS drag", () => {
    expect(hasOsFiles(transfer({ Files: "" }))).toBe(true);
    expect(hasOsFiles(transfer({ "text/plain": "hi" }))).toBe(false);
    expect(hasOsFiles(null)).toBe(false);
  });
});

describe("nodeDataForPayload", () => {
  it("maps a file to a File node titled with its path (SPEC §5)", () => {
    const data = nodeDataForPayload(
      { kind: "file", path: "src/auth/login.ts", name: "login.ts", size: 42 },
      context,
    );
    expect(data).toMatchObject({
      kind: "file",
      title: "src/auth/login.ts",
      path: "src/auth/login.ts",
      language: "TypeScript",
      subtitle: "TypeScript",
      mimeType: "text/plain",
      size: 42,
      readonly: true,
      syncPolicy: "local_only",
      status: "idle",
    });
  });

  it("maps a folder to a linked Context node", () => {
    const data = nodeDataForPayload(
      { kind: "folder", path: "src/auth", name: "auth" },
      context,
    );
    expect(data).toMatchObject({
      kind: "context",
      title: "auth",
      path: "src/auth",
      status: "linked",
      subtitle: "dnd.subtitle.folder",
    });
  });

  it("maps a repo image to an Image node that keeps its source path", () => {
    const data = nodeDataForPayload(
      {
        kind: "image",
        path: "assets/logo.png",
        name: "logo.png",
        mimeType: "image/png",
      },
      context,
    );
    expect(data).toMatchObject({
      kind: "image",
      title: "logo.png",
      sourcePath: "assets/logo.png",
      mimeType: "image/png",
    });
    // The runtime serves text only, so there is no data URL to inline yet.
    expect(data.kind === "image" && data.src.startsWith("data:")).toBe(true);
  });

  it("maps a palette card to a blank node of that type", () => {
    const data = nodeDataForPayload({ kind: "node", type: "task" }, context);
    expect(data).toMatchObject({ kind: "task", title: "任务", status: "idle" });
  });
});

describe("noteDataFromText", () => {
  it("uses the first line as the title, truncated at 18 characters", () => {
    const note = noteDataFromText(
      "  修复登录接口在高并发下的限流问题以及重试策略\n第二行  ",
      "来自粘贴",
    );
    expect(note).toMatchObject({ kind: "note", subtitle: "来自粘贴" });
    expect(note.kind === "note" && note.title).toBe(
      "修复登录接口在高并发下的限流问题以及…",
    );
    expect(note.kind === "note" && note.content.endsWith("第二行")).toBe(true);
  });

  it("falls back to the subtitle when the text starts with a blank line", () => {
    const note = noteDataFromText("\n\nbody", "来自粘贴");
    expect(note.title).toBe("body");
  });
});

describe("helpers", () => {
  it("classifies image extensions", () => {
    for (const name of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.svg"])
      expect(isImagePath(name)).toBe(true);
    expect(isImagePath("g.ts")).toBe(false);
    expect(isImagePath("Makefile")).toBe(false);
  });

  it("guesses languages and mime types", () => {
    expect(guessLanguage("a/b.rs")).toBe("Rust");
    expect(guessLanguage("a/b.unknown")).toBe("");
    expect(guessMimeType("readme.md")).toBe("text/markdown");
    expect(guessMimeType("binary.bin")).toBe("application/octet-stream");
  });

  it("formats subtitles and clamps titles", () => {
    expect(formatOf("image/svg+xml")).toBe("SVG");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4096)).toBe("4 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(clampTitle("   ")).toBe("…");
    expect(clampTitle("x".repeat(200))).toHaveLength(160);
  });
});
