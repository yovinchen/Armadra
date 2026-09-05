import { describe, expect, it, vi } from "vitest";
import { MAX_IMPORT_FILES, type FileEntry } from "@armadra/shared";
import {
  createWorkspaceFileDrag,
  readWorkspaceFileDrag,
  writeWorkspaceFileDrag,
  assertDragScope,
  assertRelativeWorkspacePath,
  hasWorkspaceFileDrag,
  fileDragMessage,
  FileDragError,
  WORKSPACE_FILES_MIME,
} from "./workspace-drag";

const RUNTIME = "http://127.0.0.1:55140";
const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed10";
const entry: FileEntry = {
  path: "src/a file.ts",
  name: "a file.ts",
  kind: "file" as const,
  size: 1,
  readonly: false,
};

describe("workspace file drag contract", () => {
  it("writes only the typed MIME with source scope", () => {
    const transfer = {
      effectAllowed: "none" as DataTransfer["effectAllowed"],
      setData: vi.fn(),
    };
    writeWorkspaceFileDrag(transfer, RUNTIME, WORKSPACE, [entry]);
    expect(transfer.effectAllowed).toBe("copy");
    expect(transfer.setData).toHaveBeenCalledOnce();
    expect(transfer.setData.mock.calls[0]?.[0]).toBe(WORKSPACE_FILES_MIME);
    const drag = readWorkspaceFileDrag({
      getData: () => transfer.setData.mock.calls[0]?.[1] as string,
    });
    expect(drag.entries[0]?.path).toBe(entry.path);
    expect(() =>
      assertDragScope(drag, "http://127.0.0.1:55141", WORKSPACE),
    ).toThrow("fileDrag.scopeMismatch");
    expect(() =>
      assertDragScope(drag, RUNTIME, "019ff7d1-0d12-7421-833d-2c5e8d64ed99"),
    ).toThrow("fileDrag.scopeMismatch");
  });

  it.each([
    "../secret",
    "/root/a",
    "C:/path",
    "a/../b",
    "a\\b",
    "a\nb",
    "a\rb",
    "a\tb",
    "a\u001bb",
    "a\u007fb",
  ])("rejects unsafe path %j", (path) => {
    expect(() =>
      createWorkspaceFileDrag(RUNTIME, WORKSPACE, [
        { ...entry, path, name: path.split("/").at(-1)! },
      ]),
    ).toThrow();
  });

  it("rejects ambiguous normalized names and unrecognized contracts", () => {
    expect(() =>
      createWorkspaceFileDrag(RUNTIME, WORKSPACE, [
        { ...entry, path: "a/b", name: "a\\b" },
      ]),
    ).toThrow();
    for (const payload of ["bad json", "{}", "x".repeat(65537)])
      expect(() => readWorkspaceFileDrag({ getData: () => payload })).toThrow();
  });
});

function rawPayload(patch: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    runtimeUrl: RUNTIME,
    workspaceId: WORKSPACE,
    entries: [{ path: "资料/报告's.md", name: "报告's.md", kind: "file" }],
    ...patch,
  });
}
function read(text: string) {
  return readWorkspaceFileDrag({ getData: () => text });
}

describe("typed workspace drag boundaries", () => {
  it("round-trips files and directories with spaces, Unicode and apostrophes", () => {
    const selected: FileEntry[] = [
      {
        path: "资料/报告's.md",
        name: "报告's.md",
        kind: "file",
        size: 13,
        readonly: false,
      },
      {
        path: "work tree/目录",
        name: "目录",
        kind: "directory",
        size: 0,
        readonly: true,
      },
    ];
    const transfer = {
      effectAllowed: "none" as DataTransfer["effectAllowed"],
      setData: vi.fn(),
    };
    writeWorkspaceFileDrag(transfer, RUNTIME, WORKSPACE, selected);
    const getData = vi.fn((type: string) =>
      type === WORKSPACE_FILES_MIME
        ? (transfer.setData.mock.calls[0]?.[1] as string)
        : "unquoted external text",
    );
    const payload = readWorkspaceFileDrag({ getData });
    expect(getData).toHaveBeenCalledWith(WORKSPACE_FILES_MIME);
    expect(payload).toEqual({
      version: 1,
      runtimeUrl: RUNTIME,
      workspaceId: WORKSPACE,
      entries: selected.map(({ name, path, kind }) => ({ name, path, kind })),
    });
    expect(() => assertDragScope(payload, RUNTIME, WORKSPACE)).not.toThrow();
    expect(transfer.setData.mock.calls.map(([type]) => type)).toEqual([
      WORKSPACE_FILES_MIME,
    ]);
  });

  it("distinguishes internal typed drag from OS files and plain text", () => {
    expect(hasWorkspaceFileDrag({ types: [WORKSPACE_FILES_MIME] })).toBe(true);
    expect(hasWorkspaceFileDrag({ types: ["Files", "text/plain"] })).toBe(
      false,
    );
    expect(hasWorkspaceFileDrag({ types: [] })).toBe(false);
    expect(() =>
      readWorkspaceFileDrag({
        getData: (type) => (type === "text/plain" ? "/repo/file.txt" : ""),
      }),
    ).toThrow("fileDrag.invalidPayload");
  });

  it.each([0, 2, "1", null, false])(
    "rejects contract version %j instead of guessing compatibility",
    (version) => {
      expect(() => read(rawPayload({ version }))).toThrow(
        "fileDrag.invalidPayload",
      );
    },
  );

  it("refuses missing scope, empty selection, malformed entries and mismatching filenames", () => {
    for (const patch of [
      { runtimeUrl: null },
      { workspaceId: "" },
      { entries: [] },
      { entries: null },
      { entries: [null] },
      { entries: [{ path: "a.txt", name: "a.txt", kind: "device" }] },
      { entries: [{ path: 123, name: "a.txt", kind: "file" }] },
    ])
      expect(() => read(rawPayload(patch))).toThrow("fileDrag.invalidPayload");
    for (const name of ["another.md", "../报告's.md", "folder/报告's.md"]) {
      expect(() =>
        read(
          rawPayload({
            entries: [{ path: "资料/报告's.md", name, kind: "file" }],
          }),
        ),
      ).toThrow("fileDrag.invalidPath");
    }
  });

  it("rejects all C0 and DEL characters before writing a DataTransfer", () => {
    for (const code of [
      ...Array.from({ length: 32 }, (_, index) => index),
      127,
    ]) {
      const name = `before${String.fromCharCode(code)}after.txt`;
      const transfer = {
        effectAllowed: "none" as DataTransfer["effectAllowed"],
        setData: vi.fn(),
      };
      expect(() =>
        writeWorkspaceFileDrag(transfer, RUNTIME, WORKSPACE, [
          { ...entry, name, path: name },
        ]),
      ).toThrow("fileDrag.invalidPath");
      expect(transfer.setData).not.toHaveBeenCalled();
      expect(transfer.effectAllowed).toBe("none");
    }
  });

  it.each([
    "a//b",
    "a/./b",
    "./a",
    "a/..",
    "a/../b",
    "//server/share",
    "C:relative",
    "a/",
    "",
  ])("rejects relative path ambiguity %j", (path) => {
    expect(() => assertRelativeWorkspacePath(path)).toThrow(
      "fileDrag.invalidPath",
    );
  });

  it("limits the entire typed payload as well as item count and path length", () => {
    const small = Array.from({ length: MAX_IMPORT_FILES }, (_, index) => ({
      ...entry,
      path: `file-${index}`,
      name: `file-${index}`,
    }));
    expect(
      createWorkspaceFileDrag(RUNTIME, WORKSPACE, small).entries,
    ).toHaveLength(MAX_IMPORT_FILES);
    expect(() =>
      createWorkspaceFileDrag(RUNTIME, WORKSPACE, [...small, entry]),
    ).toThrow("fileDrag.invalidPayload");
    const large = Array.from({ length: 30 }, (_, index) => {
      const name = "文".repeat(1200) + index + ".txt";
      return { path: name, name, kind: "file" };
    });
    const oversized = rawPayload({ entries: large });
    expect(oversized.length).toBeGreaterThan(65_536);
    expect(() => read(oversized)).toThrow("fileDrag.invalidPayload");
    expect(() => assertRelativeWorkspacePath("a".repeat(4097))).toThrow(
      "fileDrag.invalidPath",
    );
  });

  it("never normalizes two execution scopes into an assumed match", () => {
    const payload = read(rawPayload());
    for (const runtime of [
      "http://localhost:55140",
      `${RUNTIME}/`,
      "http://127.0.0.1:55141",
    ]) {
      expect(() => assertDragScope(payload, runtime, WORKSPACE)).toThrow(
        "fileDrag.scopeMismatch",
      );
    }
  });

  it("exposes a translated error key without leaking arbitrary backend details", () => {
    expect(fileDragMessage(new FileDragError("fileDrag.invalidPath"))).toBe(
      "fileDrag.invalidPath",
    );
    expect(
      fileDragMessage(new Error("backend path or other internal detail")),
    ).toBe("fileDrag.failed");
  });
});
