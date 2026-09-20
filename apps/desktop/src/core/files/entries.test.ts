import {
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../workspaces/support";
import {
  TRASH_DIRECTORY,
  createEntry,
  listTrash,
  renameEntry,
  restoreTrash,
  trashEntry,
} from "./entries";
import { type Temporary, temporary } from "./workspace.fixture";

/** Ported from the test module of `apps/runtime/src/file_ops.rs`. */

function refusal(run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("managing workspace entries", () => {
  let root: Temporary;
  beforeEach(() => {
    root = temporary();
  });
  afterEach(() => {
    root.remove();
  });

  it("creates files and folders but never overwrites", () => {
    const file = createEntry(root.path, "notes.txt", "file");
    expect(file.path).toBe("notes.txt");
    expect(statSync(join(root.path, "notes.txt")).isFile()).toBe(true);

    const folder = createEntry(root.path, "src", "directory");
    expect(folder.kind).toBe("directory");
    expect(statSync(join(root.path, "src")).isDirectory()).toBe(true);

    writeFileSync(join(root.path, "notes.txt"), "keep");
    expect(
      refusal(() => createEntry(root.path, "notes.txt", "file")).status,
    ).toBe(409);
    expect(readFileSync(join(root.path, "notes.txt"), "utf8")).toBe("keep");
  });

  it("refuses escapes, reserved folders and missing parents", () => {
    for (const bad of ["../outside.txt", "/etc/hosts", "a/../../escape"]) {
      expect(
        refusal(() => createEntry(root.path, bad, "file")).status,
        bad,
      ).toBe(400);
    }
    expect(
      refusal(() => createEntry(root.path, "missing/child.txt", "file")).status,
    ).toBe(404);
    mkdirSync(join(root.path, ".armadra"));
    expect(
      refusal(() => createEntry(root.path, ".armadra/sneak.txt", "file"))
        .status,
    ).toBe(403);
  });

  it("renames and moves without clobbering", () => {
    mkdirSync(join(root.path, "src"));
    writeFileSync(join(root.path, "a.txt"), "one");
    writeFileSync(join(root.path, "b.txt"), "two");

    const moved = renameEntry(root.path, "a.txt", "src/a.txt");
    expect(moved.path).toBe("src/a.txt");
    expect(readFileSync(join(root.path, "src/a.txt"), "utf8")).toBe("one");
    expect(() => statSync(join(root.path, "a.txt"))).toThrow();

    expect(
      refusal(() => renameEntry(root.path, "src/a.txt", "b.txt")).status,
    ).toBe(409);
    expect(readFileSync(join(root.path, "b.txt"), "utf8")).toBe("two");

    expect(
      refusal(() => renameEntry(root.path, "src", "src/inner")).status,
    ).toBe(400);
  });

  it("refuses to rename or trash through a symbolic link", () => {
    const outside = temporary();
    try {
      writeFileSync(join(outside.path, "secret.txt"), "keep");
      symlinkSync(
        join(outside.path, "secret.txt"),
        join(root.path, "leak.txt"),
      );
      expect(
        refusal(() => renameEntry(root.path, "leak.txt", "moved.txt")).status,
      ).toBe(403);
      expect(refusal(() => trashEntry(root.path, "leak.txt")).status).toBe(403);
      expect(readFileSync(join(outside.path, "secret.txt"), "utf8")).toBe(
        "keep",
      );
    } finally {
      outside.remove();
    }
  });

  it("moves the bytes into the trash and restores them", () => {
    mkdirSync(join(root.path, "src"));
    writeFileSync(join(root.path, "src/note.txt"), "content");

    const entry = trashEntry(root.path, "src/note.txt");
    expect(entry.originalPath).toBe("src/note.txt");
    expect(entry.kind).toBe("file");
    expect(() => statSync(join(root.path, "src/note.txt"))).toThrow();
    // The bytes are still there, under the trash slot.
    expect(
      readFileSync(
        join(root.path, TRASH_DIRECTORY, entry.id, "payload", "note.txt"),
        "utf8",
      ),
    ).toBe("content");

    const listed = listTrash(root.path);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(entry.id);

    const restored = restoreTrash(root.path, entry.id);
    expect(restored.path).toBe("src/note.txt");
    expect(readFileSync(join(root.path, "src/note.txt"), "utf8")).toBe(
      "content",
    );
    expect(listTrash(root.path)).toEqual([]);
  });

  it("trashes folders and refuses to restore over a new file", () => {
    mkdirSync(join(root.path, "old/deep"), { recursive: true });
    writeFileSync(join(root.path, "old/deep/x.txt"), "x");

    const entry = trashEntry(root.path, "old");
    expect(entry.kind).toBe("directory");
    expect(() => statSync(join(root.path, "old"))).toThrow();

    mkdirSync(join(root.path, "old"));
    expect(refusal(() => restoreTrash(root.path, entry.id)).status).toBe(409);
    // Nothing was lost by the refused restore.
    expect(
      statSync(
        join(root.path, TRASH_DIRECTORY, entry.id, "payload", "old/deep/x.txt"),
      ).isFile(),
    ).toBe(true);
  });

  it("keeps the trash out of the workspace's Git status", () => {
    writeFileSync(join(root.path, "gone.txt"), "bytes");
    trashEntry(root.path, "gone.txt");
    // `*` also matches the marker itself, so the whole managed folder — trash,
    // imports, assets — stays invisible to `git status`.
    expect(readFileSync(join(root.path, ".armadra", ".gitignore"), "utf8")).toBe(
      "*\n",
    );
    // A marker the user edited is theirs; a second delete leaves it alone.
    writeFileSync(join(root.path, ".armadra", ".gitignore"), "*\n!keep\n");
    writeFileSync(join(root.path, "gone-too.txt"), "bytes");
    trashEntry(root.path, "gone-too.txt");
    expect(readFileSync(join(root.path, ".armadra", ".gitignore"), "utf8")).toBe(
      "*\n!keep\n",
    );
  });

  it("refuses unknown trash ids without touching the filesystem", () => {
    expect(refusal(() => restoreTrash(root.path, "../../etc")).status).toBe(
      400,
    );
    expect(
      refusal(() =>
        restoreTrash(root.path, "0198f000-0000-7000-8000-000000000000"),
      ).status,
    ).toBe(404);
  });
});
