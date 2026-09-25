import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Temporary, temporary } from "../files/workspace.fixture";
import { directorySource } from "../workspaces/directory";
import { DomainError } from "../workspaces/support";
import { ImportBatch, fileInfo, relativePath } from "./batch";
import { IMPORTS_DIRECTORY, MAX_FILE_BYTES } from "./limits";

/** Ported from the test module of the pre-merge implementation. */

function refuses(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch (error) {
    if (error instanceof DomainError) return true;
    // An `EEXIST`/`ENOENT` refusal counts too: the Rust version answers with
    // an `AppError` built from the same `io::Error`.
    return error instanceof Error;
  }
}

describe("import batches", () => {
  const made: Temporary[] = [];
  const temp = (): Temporary => {
    const one = temporary("armadra-imports-");
    made.push(one);
    return one;
  };
  afterEach(() => {
    for (const one of made.splice(0)) one.remove();
  });

  it("commits an empty workspace copy and removes an unregistered one", () => {
    const root = temp();
    const parent = join(root.path, "managed");

    let path = "";
    expect(() =>
      ImportBatch.workspace(parent).commitWorkspace((where) => {
        path = where;
        throw new Error("the row could not be written");
      }),
    ).toThrow();
    expect(() => statSync(path)).toThrow();

    const batch = ImportBatch.workspace(parent);
    batch.directory("empty/nested");
    const kept = batch.commitWorkspace((where) => where);
    expect(statSync(join(kept, "empty/nested")).isDirectory()).toBe(true);
  });

  it("rejects files and traversal as a directory source", () => {
    const root = temp();
    writeFileSync(join(root.path, "file.txt"), "x");
    expect(directorySource(root.path)).toBe(root.path);
    expect(refuses(() => directorySource(join(root.path, "file.txt")))).toBe(
      true,
    );
    expect(refuses(() => directorySource(`${root.path}/../`))).toBe(true);
    expect(refuses(() => directorySource("relative"))).toBe(true);
    symlinkSync(root.path, join(root.path, "linked-folder"));
    expect(
      refuses(() => directorySource(join(root.path, "linked-folder"))),
    ).toBe(true);
  });

  it("imports nested, empty and binary files without overwriting", () => {
    const root = temp();
    const batch = ImportBatch.into(root.path);
    batch.write("src/a.txt", Buffer.from("hello"));
    batch.write("empty.txt", Buffer.alloc(0));
    batch.write("report.pdf", Buffer.from("%PDF-1.7\n"));
    expect(
      refuses(() => batch.write("src/a.txt", Buffer.from("changed"))),
    ).toBe(true);
    const result = batch.commit(root.path);
    expect(result.files[0]?.preview).toBe("text");
    expect(result.files[1]?.size).toBe(0);
    expect(result.files[2]?.preview).toBe("pdf");
    expect(readFileSync(join(root.path, result.files[0]?.path ?? ""))).toEqual(
      Buffer.from("hello"),
    );
    expect(result.path.startsWith(`${IMPORTS_DIRECTORY}/`)).toBe(true);
  });

  it("keeps imported copies out of the workspace's Git status", () => {
    const root = temp();
    ImportBatch.into(root.path).commit(root.path);
    expect(
      readFileSync(join(root.path, ".armadra", ".gitignore"), "utf8"),
    ).toBe("*\n");
  });

  it("preserves every desktop copy with the same basename", () => {
    const root = temp();
    const sources = temp();
    mkdirSync(join(sources.path, "a"));
    mkdirSync(join(sources.path, "b"));
    const originals = [
      Buffer.from([0x66, 0x69, 0x72, 0x73, 0x74, 0x00, 0x70]),
      Buffer.from([0x73, 0x65, 0x63, 0x6f, 0x6e, 0x64, 0x00, 0x70]),
    ];
    for (const [index, directory] of ["a", "b"].entries()) {
      writeFileSync(
        join(sources.path, directory, "report.txt"),
        originals[index] as Buffer,
      );
    }
    writeFileSync(join(root.path, "report.txt"), "existing workspace file");

    const batch = ImportBatch.into(root.path);
    for (const directory of ["a", "b"]) {
      batch.copy(root.path, join(sources.path, directory, "report.txt"));
    }
    const result = batch.commit(root.path);
    expect(result.files.map((file) => file.name)).toEqual([
      "report.txt",
      "report-2.txt",
    ]);
    for (const [index, file] of result.files.entries()) {
      expect(readFileSync(join(root.path, file.path))).toEqual(
        originals[index] as Buffer,
      );
    }
    expect(readFileSync(join(root.path, "report.txt"), "utf8")).toBe(
      "existing workspace file",
    );
    expect(readFileSync(join(sources.path, "a/report.txt"))).toEqual(
      originals[0] as Buffer,
    );
  });

  it("skips directories and existing suffixes when allocating copy names", () => {
    const root = temp();
    const sources = temp();
    const source = join(sources.path, "report.txt");
    writeFileSync(source, "new copy");
    const batch = ImportBatch.into(root.path);
    batch.write("report.txt/nested.txt", Buffer.from("nested structure"));
    batch.directory("report-2.txt");
    batch.write("report-3.txt", Buffer.from("existing suffix"));
    batch.copy(root.path, source);
    const result = batch.commit(root.path);
    const destination = join(root.path, result.path);
    expect(statSync(join(destination, "report.txt")).isDirectory()).toBe(true);
    expect(statSync(join(destination, "report-2.txt")).isDirectory()).toBe(
      true,
    );
    expect(
      readFileSync(join(destination, "report.txt/nested.txt"), "utf8"),
    ).toBe("nested structure");
    expect(readFileSync(join(destination, "report-3.txt"), "utf8")).toBe(
      "existing suffix",
    );
    expect(readFileSync(join(destination, "report-4.txt"), "utf8")).toBe(
      "new copy",
    );
  });

  it("keeps dotfiles and extensionless names when suffixing", () => {
    const root = temp();
    const sources = temp();
    const batch = ImportBatch.into(root.path);
    for (const name of [".env", "Makefile"]) {
      const source = join(sources.path, name);
      writeFileSync(source, "preserved");
      batch.copy(root.path, source);
      batch.copy(root.path, source);
    }
    const result = batch.commit(root.path);
    expect(result.files.map((file) => file.name)).toEqual([
      ".env",
      ".env-2",
      "Makefile",
      "Makefile-2",
    ]);
  });

  it("rolls a failed batch back after renaming copies", () => {
    const root = temp();
    const sources = temp();
    const source = join(sources.path, "report.txt");
    writeFileSync(source, "source unchanged");
    const batch = ImportBatch.into(root.path);
    batch.copy(root.path, source);
    batch.copy(root.path, source);
    // Manifest writes remain strict; suffix allocation applies only to copies.
    expect(
      refuses(() => batch.write("report-2.txt", Buffer.from("overwrite"))),
    ).toBe(true);
    batch.discard();
    expect(readdirSync(join(root.path, IMPORTS_DIRECTORY))).toEqual([]);
    expect(readFileSync(source, "utf8")).toBe("source unchanged");
  });

  it("rejects traversal and cleans failed batches", () => {
    for (const path of [
      "../a",
      "/tmp/a",
      "a/../b",
      "a\\..\\b",
      "C:\\fakepath\\a",
      "a//b",
      ".",
      "",
    ]) {
      expect(
        refuses(() => relativePath(path)),
        path,
      ).toBe(true);
    }
    const root = temp();
    const batch = ImportBatch.into(root.path);
    batch.write("a", Buffer.from("small"));
    expect(
      refuses(() => batch.write("large", Buffer.alloc(MAX_FILE_BYTES + 1))),
    ).toBe(true);
    batch.discard();
    expect(readdirSync(join(root.path, IMPORTS_DIRECTORY))).toEqual([]);
  });

  it("refuses source and destination symlinks and outside reads", () => {
    const root = temp();
    const outside = temp();
    writeFileSync(join(outside.path, "a.txt"), "secret");
    symlinkSync(join(outside.path, "a.txt"), join(root.path, "link"));
    const batch = ImportBatch.into(root.path);
    expect(refuses(() => batch.copy(root.path, "link"))).toBe(true);
    expect(
      refuses(() => fileInfo(root.path, join(outside.path, "a.txt"))),
    ).toBe(true);
    batch.discard();

    const other = temp();
    rmSync(join(other.path, ".armadra"), { recursive: true, force: true });
    symlinkSync(outside.path, join(other.path, ".armadra"));
    expect(refuses(() => ImportBatch.into(other.path))).toBe(true);
  });

  it("previews playable media and PDFs, and only below the download limit", () => {
    const root = temp();
    writeFileSync(join(root.path, "clip.mp4"), Buffer.from([0, 0, 0, 1]));
    writeFileSync(join(root.path, "take.mp3"), Buffer.from([0xff, 0xfb]));
    writeFileSync(join(root.path, "spec.pdf"), "%PDF-1.7\n");
    writeFileSync(join(root.path, "old.avi"), Buffer.from([0, 1]));
    writeFileSync(
      join(root.path, "huge.webm"),
      Buffer.alloc(MAX_FILE_BYTES + 1),
    );
    expect(fileInfo(root.path, "clip.mp4").preview).toBe("video");
    expect(fileInfo(root.path, "take.mp3").preview).toBe("audio");
    expect(fileInfo(root.path, "spec.pdf").preview).toBe("pdf");
    // 页面播放不了的容器不装成预览。
    expect(fileInfo(root.path, "old.avi").preview).toBe("download");
    // 预览要整份取回，超过下载上限只能下载。
    expect(fileInfo(root.path, "huge.webm").preview).toBe("download");
  });
});
