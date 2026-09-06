import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFile = vi.fn();
const applyLanguageEdit = vi.fn();
vi.mock("@/api/client", () => ({
  runtimeApi: {
    readFile: (...args: unknown[]) => readFile(...args),
    applyLanguageEdit: (...args: unknown[]) => applyLanguageEdit(...args),
  },
}));

import {
  applyEditPreview,
  applyTextEdits,
  buildEditPreview,
  parseWorkspaceEdit,
} from "./edit-preview";
import { registerOpenFile, resetOpenFiles } from "./open-files";

const SHA = "a".repeat(64);
const OTHER = "b".repeat(64);

beforeEach(() => {
  readFile.mockReset();
  applyLanguageEdit.mockReset().mockResolvedValue({ applied: [], failed: [] });
  resetOpenFiles();
});
afterEach(resetOpenFiles);

describe("applying LSP text edits", () => {
  it("applies several edits in one pass without shifting each other", () => {
    const text = "alpha beta gamma\nsecond line\n";
    const result = applyTextEdits(text, [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
        newText: "ALPHA",
      },
      {
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 6 },
        },
        newText: "SECOND",
      },
    ]);
    expect(result).toBe("ALPHA beta gamma\nSECOND line\n");
  });

  it("counts characters as UTF-16 units, the way LSP does", () => {
    // `character` 是码元，不是码点：JS 下标正好是同一套。
    const text = "x = '🐟'\n";
    const result = applyTextEdits(text, [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        newText: "y",
      },
    ]);
    expect(result).toBe("y = '🐟'\n");
  });

  it("clamps a position past the end of the document", () => {
    expect(
      applyTextEdits("one\n", [
        {
          range: {
            start: { line: 9, character: 9 },
            end: { line: 9, character: 9 },
          },
          newText: "two\n",
        },
      ]),
    ).toBe("one\ntwo\n");
  });
});

describe("reading a WorkspaceEdit", () => {
  it("keeps documentChanges in the order the server gave them", () => {
    expect(
      parseWorkspaceEdit({
        documentChanges: [
          { textDocument: { uri: "armadra:///b.py" }, edits: [] },
          { textDocument: { uri: "armadra:///a.py" }, edits: [] },
        ],
      }).map((file) => file.uri),
    ).toEqual(["armadra:///b.py", "armadra:///a.py"]);
  });

  it("sorts the `changes` map, which has no order of its own", () => {
    expect(
      parseWorkspaceEdit({
        changes: { "armadra:///b.py": [], "armadra:///a.py": [] },
      }).map((file) => file.uri),
    ).toEqual(["armadra:///a.py", "armadra:///b.py"]);
  });

  it("marks create / rename / delete as a file operation", () => {
    const [entry] = parseWorkspaceEdit({
      documentChanges: [{ kind: "rename", oldUri: "a", newUri: "b" }],
    });
    expect(entry!.fileOperation).toBe(true);
  });
});

describe("building the preview", () => {
  const rename = {
    changes: {
      "armadra:///src/main.py": [
        {
          range: {
            start: { line: 0, character: 4 },
            end: { line: 0, character: 7 },
          },
          newText: "bar",
        },
      ],
      "armadra:///src/other.py": [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 3 },
          },
          newText: "bar",
        },
      ],
    },
  };

  it("diffs every file and carries the version it previewed against", async () => {
    readFile.mockImplementation((_workspace: string, path: string) =>
      Promise.resolve(
        path === "src/main.py"
          ? { content: "def foo():\n", sha256: SHA }
          : { content: "foo()\n", sha256: OTHER },
      ),
    );
    const preview = await buildEditPreview({
      workspaceId: "w1",
      sessionId: "s1",
      title: "rename",
      edit: rename,
    });
    expect(preview.blocked).toBe(false);
    expect(preview.files.map((file) => file.path)).toEqual([
      "src/main.py",
      "src/other.py",
    ]);
    expect(preview.files[0]!.patch).toContain("-def foo():");
    expect(preview.files[0]!.patch).toContain("+def bar():");
    expect(preview.files[0]!.expectedSha256).toBe(SHA);
    expect(preview.files[1]!.expectedSha256).toBe(OTHER);
  });

  it("uses the editor's buffer for an open file rather than the disk", async () => {
    registerOpenFile("node", {
      path: "src/main.py",
      dirty: false,
      sha256: SHA,
      read: () => "def foo():\n",
    });
    readFile.mockResolvedValue({ content: "foo()\n", sha256: OTHER });
    const preview = await buildEditPreview({
      workspaceId: "w1",
      sessionId: "s1",
      title: "rename",
      edit: rename,
    });
    // 打开的那个没走 readFile；另一个走了。
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(preview.files[0]!.patch).toContain("+def bar():");
  });

  it("blocks the whole edit when a touched file has unsaved changes", async () => {
    registerOpenFile("node", {
      path: "src/main.py",
      dirty: true,
      sha256: SHA,
      read: () => "def foo():\n",
    });
    readFile.mockResolvedValue({ content: "foo()\n", sha256: OTHER });
    const preview = await buildEditPreview({
      workspaceId: "w1",
      sessionId: "s1",
      title: "rename",
      edit: rename,
    });
    expect(preview.blocked).toBe(true);
    expect(preview.files[0]!.blocked).toBe("dirty");
    // 半个重命名比不重命名更糟，所以另一个文件也不写。
    expect(preview.files[1]!.blocked).toBeUndefined();
  });

  it("blocks a path outside the workspace and one that needs a file created", async () => {
    const preview = await buildEditPreview({
      workspaceId: "w1",
      sessionId: "s1",
      title: "action",
      edit: {
        documentChanges: [
          { textDocument: { uri: "armadra-external:///0f0f" }, edits: [] },
          { kind: "create", uri: "armadra:///new.py" },
        ],
      },
    });
    expect(preview.files.map((file) => file.blocked)).toEqual([
      "external",
      "fileOperation",
    ]);
    expect(preview.blocked).toBe(true);
  });

  it("blocks a file it cannot read instead of writing over it blind", async () => {
    readFile.mockRejectedValue(new Error("gone"));
    const preview = await buildEditPreview({
      workspaceId: "w1",
      sessionId: "s1",
      title: "rename",
      edit: { changes: { "armadra:///src/main.py": [] } },
    });
    expect(preview.files[0]!.blocked).toBe("unreadable");
  });

  it("sends the previewed versions back as the write credential", async () => {
    readFile.mockImplementation((_workspace: string, path: string) =>
      Promise.resolve(
        path === "src/main.py"
          ? { content: "def foo():\n", sha256: SHA }
          : { content: "foo()\n", sha256: OTHER },
      ),
    );
    const preview = await buildEditPreview({
      workspaceId: "w1",
      sessionId: "s1",
      title: "rename",
      edit: rename,
    });
    await applyEditPreview(preview);
    expect(applyLanguageEdit).toHaveBeenCalledWith("w1", "s1", rename, {
      "src/main.py": SHA,
      "src/other.py": OTHER,
    });
  });
});
