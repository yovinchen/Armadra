import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../workspaces/support";
import { UTF8_BOM, listDirectory, readRawFile, readTextFile } from "./read";
import { type Temporary, temporary } from "./workspace.fixture";

/**
 * Ported from the read half of `apps/runtime/src/files.rs`'s test module:
 * `lists_directories_before_files_and_ignores_build_folders`,
 * `rejects_binary_previews` and `reports_line_endings_bom_and_encoding`.
 */

describe("reading workspace files", () => {
  let root: Temporary;
  beforeEach(() => {
    root = temporary();
  });
  afterEach(() => {
    root.remove();
  });

  it("lists directories before files and ignores build folders", () => {
    mkdirSync(join(root.path, "src"));
    mkdirSync(join(root.path, "node_modules"));
    writeFileSync(join(root.path, "README.md"), "hello");
    const list = listDirectory(root.path, ".");
    expect(list.path).toBe(".");
    expect(list.entries[0]?.name).toBe("src");
    expect(list.entries[0]?.kind).toBe("directory");
    expect(list.entries.some((entry) => entry.name === "node_modules")).toBe(
      false,
    );
    expect(list.truncated).toBe(false);
  });

  it("rejects binary previews", () => {
    writeFileSync(join(root.path, "binary"), Buffer.from([1, 0, 2]));
    expect(() => readTextFile(root.path, "binary")).toThrowError(
      expect.objectContaining({ status: 400 }) as unknown as Error,
    );
  });

  it("reports line endings, the BOM and the encoding", () => {
    writeFileSync(join(root.path, "unix.txt"), "a\nb\n");
    writeFileSync(join(root.path, "dos.txt"), "a\r\nb\r\n");
    writeFileSync(join(root.path, "mixed.txt"), "a\r\nb\n");
    writeFileSync(join(root.path, "one.txt"), "no break");
    writeFileSync(
      join(root.path, "bom.txt"),
      Buffer.concat([UTF8_BOM, Buffer.from("hello\n", "utf8")]),
    );
    // 0xFF is not valid UTF-8 anywhere and is not a NUL, so this reaches the
    // encoding check rather than the binary one.
    writeFileSync(
      join(root.path, "latin.txt"),
      Buffer.from([0x61, 0xff, 0x0a]),
    );

    expect(readTextFile(root.path, "unix.txt").eol).toBe("lf");
    expect(readTextFile(root.path, "dos.txt").eol).toBe("crlf");
    expect(readTextFile(root.path, "mixed.txt").eol).toBe("mixed");
    expect(readTextFile(root.path, "one.txt").eol).toBe("none");

    const bom = readTextFile(root.path, "bom.txt");
    expect(bom.bom).toBe(true);
    expect(bom.content).toBe("hello\n");
    expect(bom.encoding).toBe("utf-8");
    expect(bom.sha256).toBeDefined();
    // The version covers the bytes on disk, BOM included: it is what the next
    // save is checked against, and the next save writes the BOM back.
    expect(bom.sha256).toBe(
      createHash("sha256")
        .update(Buffer.concat([UTF8_BOM, Buffer.from("hello\n", "utf8")]))
        .digest("hex"),
    );

    // Not UTF-8: shown, but with no content version, which is what makes the
    // editor read-only.
    const latin = readTextFile(root.path, "latin.txt");
    expect(latin.encoding).toBe("unknown");
    expect(latin.sha256).toBeUndefined();
  });

  it("answers the mime type mime_guess would", () => {
    writeFileSync(join(root.path, "a.md"), "# hi\n");
    writeFileSync(join(root.path, "a.ts"), "export {};\n");
    expect(readTextFile(root.path, "a.md").mimeType).toBe("text/markdown");
    // `.ts` is a transport stream to `mime_guess`, and the Runtime says so.
    expect(readTextFile(root.path, "a.ts").mimeType).toBe(
      "video/vnd.dlna.mpeg-tts",
    );
  });

  it("downloads bytes opaquely and refuses a path outside the root", () => {
    const outside = temporary();
    try {
      writeFileSync(join(outside.path, "secret.txt"), "secret");
      writeFileSync(join(root.path, "picture.svg"), "<svg/>");
      const raw = readRawFile(root.path, "picture.svg");
      expect(raw.path).toBe("picture.svg");
      // Never sniffed: an uploaded SVG must not execute in the core's origin.
      expect(raw.contentType).toBe("application/octet-stream");
      expect(raw.bytes.toString("utf8")).toBe("<svg/>");
      let refusal: unknown;
      try {
        readRawFile(root.path, join(outside.path, "secret.txt"));
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(DomainError);
      expect((refusal as DomainError).status).toBe(403);
    } finally {
      outside.remove();
    }
  });
});
