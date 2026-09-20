import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../workspaces/support";
import { MAX_WRITE_FILE_SIZE, UTF8_BOM, readTextFile } from "./read";
import { type Temporary, temporary } from "./workspace.fixture";
import { writeTextFile } from "./write";

/**
 * Ported from the write half of the pre-merge implementation's test module.
 *
 * `simultaneous_writers_cannot_both_replace_the_same_version` has no port: it
 * spawns two OS threads to prove the per-path gate closes the window between
 * the version check and the rename, and in the core that window does not
 * exist — `writeTextFile` is synchronous end to end, so the event loop cannot
 * interleave a second save into the middle of one. What the test is really
 * about, that exactly one of two writers holding the same version wins, is
 * covered by `content_version_rejects_stale_and_missing_files` below: the
 * second save's token is stale the moment the first lands.
 */

function refusal(run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("saving workspace files", () => {
  let root: Temporary;
  beforeEach(() => {
    root = temporary();
  });
  afterEach(() => {
    root.remove();
  });

  it("writes new and existing files inside the root", () => {
    mkdirSync(join(root.path, "src"));
    const created = writeTextFile(
      root.path,
      "src/new.txt",
      "一行\n",
      undefined,
      false,
    );
    expect(created.path).toBe("src/new.txt");
    expect(created.size).toBe(Buffer.byteLength("一行\n", "utf8"));
    expect(readFileSync(join(root.path, "src/new.txt"), "utf8")).toBe("一行\n");

    const updated = writeTextFile(
      root.path,
      "src/new.txt",
      "two\n",
      created.sha256,
      false,
    );
    expect(updated.size).toBe(4);
    // No temp file is left behind.
    expect(
      readdirSync(join(root.path, "src")).filter((name) =>
        name.endsWith(".armadra-tmp"),
      ),
    ).toEqual([]);
  });

  it("refuses writes outside the root", () => {
    const outside = temporary();
    try {
      writeFileSync(join(outside.path, "secret.txt"), "keep\n");
      expect(
        refusal(() =>
          writeTextFile(root.path, "../secret.txt", "hacked", undefined, false),
        ).status,
      ).toBe(400);
      expect(() =>
        writeTextFile(
          root.path,
          join(outside.path, "secret.txt"),
          "hacked",
          undefined,
          false,
        ),
      ).toThrow();
      expect(readFileSync(join(outside.path, "secret.txt"), "utf8")).toBe(
        "keep\n",
      );
    } finally {
      outside.remove();
    }
  });

  it("refuses to write through a symbolic link", () => {
    const outside = temporary();
    try {
      writeFileSync(join(outside.path, "secret.txt"), "keep\n");
      symlinkSync(
        join(outside.path, "secret.txt"),
        join(root.path, "leak.txt"),
      );
      expect(
        refusal(() =>
          writeTextFile(root.path, "leak.txt", "hacked", undefined, false),
        ).status,
      ).toBe(403);
      expect(readFileSync(join(outside.path, "secret.txt"), "utf8")).toBe(
        "keep\n",
      );
    } finally {
      outside.remove();
    }
  });

  it("rejects a stale content version and a version for a missing file", () => {
    writeFileSync(join(root.path, "note.txt"), "one\n");
    expect(
      refusal(() =>
        writeTextFile(root.path, "note.txt", "two\n", "0".repeat(64), false),
      ).status,
    ).toBe(409);
    expect(readFileSync(join(root.path, "note.txt"), "utf8")).toBe("one\n");

    const saved = writeTextFile(
      root.path,
      "note.txt",
      "two\n",
      readTextFile(root.path, "note.txt").sha256,
      false,
    );
    expect(saved.size).toBe(4);

    // A file that does not exist yet can never satisfy a CAS token.
    expect(
      refusal(() =>
        writeTextFile(root.path, "fresh.txt", "x", "0".repeat(64), false),
      ).status,
    ).toBe(409);
  });

  it("detects same-length external changes and requires a version", () => {
    const file = join(root.path, "note.txt");
    writeFileSync(file, "old");
    const original = readTextFile(root.path, "note.txt");
    writeFileSync(file, "new");
    expect(
      refusal(() =>
        writeTextFile(root.path, "note.txt", "mine", original.sha256, false),
      ).status,
    ).toBe(409);
    expect(
      refusal(() =>
        writeTextFile(root.path, "note.txt", "mine", undefined, false),
      ).status,
    ).toBe(409);
    expect(readFileSync(file, "utf8")).toBe("new");
  });

  it("keeps literal whitespace names distinct and preserves read-only files", () => {
    writeTextFile(root.path, "note", "plain", undefined, false);
    const spaced = writeTextFile(
      root.path,
      " note ",
      "space",
      undefined,
      false,
    );
    expect(readTextFile(root.path, " note ").sha256).toBe(spaced.sha256);
    expect(readFileSync(join(root.path, "note"), "utf8")).toBe("plain");

    const path = join(root.path, " note ");
    chmodSync(path, 0o444);
    expect(
      refusal(() =>
        writeTextFile(root.path, " note ", "later", spaced.sha256, false),
      ).status,
    ).toBe(403);
    expect(readFileSync(path, "utf8")).toBe("space");
  });

  it("round-trips a byte order mark", () => {
    writeFileSync(
      join(root.path, "bom.txt"),
      Buffer.concat([UTF8_BOM, Buffer.from("one\n", "utf8")]),
    );
    const read = readTextFile(root.path, "bom.txt");
    writeTextFile(root.path, "bom.txt", "two\n", read.sha256, read.bom);
    expect(readFileSync(join(root.path, "bom.txt"))).toEqual(
      Buffer.concat([UTF8_BOM, Buffer.from("two\n", "utf8")]),
    );
    expect(readTextFile(root.path, "bom.txt").bom).toBe(true);
  });

  it("refuses payloads above the write limit", () => {
    const oversized = "a".repeat(MAX_WRITE_FILE_SIZE + 1);
    expect(
      refusal(() =>
        writeTextFile(root.path, "big.txt", oversized, undefined, false),
      ).status,
    ).toBe(400);
    expect(() => readFileSync(join(root.path, "big.txt"))).toThrow();
  });

  it("refuses a content version that is not a SHA-256", () => {
    writeFileSync(join(root.path, "note.txt"), "one\n");
    const bad = refusal(() =>
      writeTextFile(root.path, "note.txt", "two\n", "not-a-hash", false),
    );
    expect(bad.status).toBe(400);
    expect(bad.message).toBe("A valid content version is required");
  });
});
