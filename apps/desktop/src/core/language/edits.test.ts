/**
 * `WorkspaceEdit` parsing, validation and application — a port of
 * the pre-merge implementation.
 */

import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Documents } from "./documents";
import {
  MAX_FILES,
  applyEdits,
  applyToText,
  dirtyFiles,
  parseEdit,
  type AppliedFile,
  type TextEdit,
} from "./edits";
import { temporaryRoot } from "./files";
import type { JsonValue } from "./jsonrpc";
import { Rewriter } from "./uri";

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const roots: string[] = [];

class Project {
  readonly root: string;
  readonly rewriter: Rewriter;

  constructor() {
    // The rewriter has to hold the canonical path: on macOS a temporary
    // directory is a symlink, and a server answers with the resolved one.
    this.root = temporaryRoot("armadra-language-edits-");
    roots.push(this.root);
    this.rewriter = new Rewriter(this.root);
  }

  write(name: string, text: string): void {
    writeFileSync(join(this.root, name), text, "utf8");
  }

  read(name: string): string {
    return readFileSync(join(this.root, name), "utf8");
  }

  uri(name: string): string {
    return this.rewriter.workspaceUri(name);
  }
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function replaceFirstLine(newText: string): JsonValue {
  return [
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 },
      },
      newText,
    },
  ];
}

describe("language/edits", () => {
  it("an edit outside the workspace blocks the whole thing", () => {
    const project = new Project();
    const edit = {
      changes: {
        [project.uri("a.txt")]: replaceFirstLine("new"),
        "armadra-external:///deadbeefdeadbeef": replaceFirstLine("new"),
      },
    };
    // Not "skip the external file": an edit that silently does less than the
    // preview showed is worse than one that does nothing.
    expect(() => parseEdit(edit, project.rewriter)).toThrow(
      /outside the workspace/,
    );
  });

  it("a file operation is refused rather than half applied", () => {
    const project = new Project();
    const edit = {
      documentChanges: [
        {
          kind: "rename",
          oldUri: project.uri("a.txt"),
          newUri: project.uri("b.txt"),
        },
      ],
    };
    expect(() => parseEdit(edit, project.rewriter)).toThrow(
      /creates, renames or deletes/,
    );
  });

  it("edits within one file apply against the original offsets", () => {
    // Two edits on the same line. Applied first-to-last, the second one lands
    // in the wrong place; applied last-to-first, both are right.
    const edits: TextEdit[] = [
      {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 },
        text: "AAAA",
      },
      {
        start: { line: 0, character: 4 },
        end: { line: 0, character: 7 },
        text: "BBBB",
      },
    ];
    expect(applyToText("one two\n", edits)).toBe("AAAA BBBB\n");
    // A range the file does not have is refused, not clamped.
    expect(
      applyToText("one\n", [
        {
          start: { line: 9, character: 0 },
          end: { line: 9, character: 1 },
          text: "x",
        },
      ]),
    ).toBeUndefined();
  });

  it("a cross-file rename writes both files and announces them", () => {
    const project = new Project();
    project.write("a.txt", "old text\n");
    project.write("b.txt", "old other\n");
    const edit = {
      changes: {
        [project.uri("a.txt")]: replaceFirstLine("new"),
        [project.uri("b.txt")]: replaceFirstLine("new"),
      },
    };
    const files = parseEdit(edit, project.rewriter);
    expect(files).toHaveLength(2);
    const announced: AppliedFile[] = [];
    const result = applyEdits(
      project.root,
      files,
      { "a.txt": sha("old text\n"), "b.txt": sha("old other\n") },
      (file) => announced.push(file),
    );
    expect(result.applied).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(project.read("a.txt")).toBe("new text\n");
    expect(project.read("b.txt")).toBe("new other\n");
    // Each write announces itself, which is how an open and clean editor
    // reloads — the same path an external change already takes.
    expect(announced.map((file) => file.path).sort()).toEqual([
      "a.txt",
      "b.txt",
    ]);
    expect(announced.every((file) => file.sha256.length === 64)).toBe(true);
  });

  it("a stale version stops the write and reports how far it got", () => {
    const project = new Project();
    project.write("a.txt", "old text\n");
    project.write("b.txt", "old other\n");
    const edit = {
      changes: {
        [project.uri("a.txt")]: replaceFirstLine("new"),
        [project.uri("b.txt")]: replaceFirstLine("new"),
      },
    };
    const files = parseEdit(edit, project.rewriter);
    const result = applyEdits(
      project.root,
      files,
      // `b.txt` changed on disk since the preview was computed.
      { "a.txt": sha("old text\n"), "b.txt": sha("something else\n") },
      () => {},
    );
    // Partial application is a real outcome, and the caller is told exactly
    // which half happened rather than getting a bare failure.
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.path).toBe("a.txt");
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe("b.txt");
    expect(result.failed[0]?.code).toBe("conflict");
    expect(project.read("b.txt")).toBe("old other\n");
  });

  it("a file with unsaved changes blocks the edit", () => {
    const project = new Project();
    project.write("a.txt", "old text\n");
    const edit = {
      changes: { [project.uri("a.txt")]: replaceFirstLine("new") },
    };
    const files = parseEdit(edit, project.rewriter);

    const documents = new Documents();
    documents.openDocument(
      "session-1",
      project.uri("a.txt"),
      "plaintext",
      "old text\n",
    );
    expect(dirtyFiles(files, documents, project.rewriter)).toHaveLength(0);

    // Once the editor has an unsaved draft, applying over it would destroy
    // work the editor is still holding.
    documents.change("session-1", project.uri("a.txt"), [
      { kind: "full", text: "a draft\n" },
    ]);
    expect(dirtyFiles(files, documents, project.rewriter)).toEqual(["a.txt"]);
  });

  it("an edit that changes nothing or too much is refused", () => {
    const project = new Project();
    expect(() => parseEdit({}, project.rewriter)).toThrow();
    expect(() => parseEdit({ changes: {} }, project.rewriter)).toThrow();
    const many: Record<string, JsonValue> = {};
    for (let index = 0; index <= MAX_FILES; index += 1) {
      many[project.uri(`f${index}.txt`)] = [];
    }
    expect(() => parseEdit({ changes: many }, project.rewriter)).toThrow(
      /more than/,
    );
  });
});
