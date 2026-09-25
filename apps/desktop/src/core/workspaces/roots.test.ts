import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import {
  canonicalize,
  isProtected,
  plainWin32Spelling,
  prepareNewDirectory,
  resolveImportSource,
  resolveInRoot,
  validDirectoryName,
  workspaceRelativePath,
} from "./roots";
import { tempDir } from "../testing/temp-dir";

/** Path narrowing, ported from the pre-merge implementation. */
describe("workspace roots", () => {
  const directory = canonicalize(tempDir("armadra-roots-"));
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("knows the system locations nothing may be created inside", () => {
    if (process.platform === "win32") {
      expect(isProtected("C:\\Windows\\System32")).toBe(true);
      return;
    }
    expect(isProtected("/usr")).toBe(true);
    expect(isProtected("/usr/local/bin")).toBe(true);
    expect(isProtected("/etc/hosts")).toBe(true);
    // Compared segment by segment, not as text.
    expect(isProtected("/usrlocal")).toBe(false);
    expect(isProtected(directory)).toBe(false);
  });

  it("accepts one plain segment as a new folder name", () => {
    expect(validDirectoryName(" project ")).toBe("project");
    for (const bad of ["", ".", "..", "-rf", "a/b", "a\\b", "a\u0000b"]) {
      expect(() => validDirectoryName(bad), bad).toThrowError(/Folder name/);
    }
    expect(() => validDirectoryName("x".repeat(121))).toThrowError();
  });

  it("refuses to hand back a path that already exists", () => {
    const fresh = prepareNewDirectory(directory, "fresh");
    mkdirSync(fresh);
    expect(() => prepareNewDirectory(directory, "fresh")).toThrowError(
      /already exists/,
    );
    // A missing parent is a 400, not a recursive mkdir.
    expect(() =>
      prepareNewDirectory(join(directory, "missing"), "deep"),
    ).toThrowError(/does not exist/);
  });

  it("keeps a relative path inside the root", () => {
    const inside = join(directory, "inside.txt");
    writeFileSync(inside, "x");
    expect(resolveInRoot(directory, "inside.txt")).toBe(inside);
    expect(resolveInRoot(directory, ".")).toBe(directory);
    expect(() => workspaceRelativePath("../escape")).toThrowError(/relative/);
    expect(() => workspaceRelativePath("/etc/hosts")).toThrowError(/relative/);
    expect(workspaceRelativePath("a\\b")).toBe("a/b");
  });

  it("lets an import name an absolute path outside the workspace, but not a link out of it", () => {
    const outside = canonicalize(tempDir("armadra-drag-"));
    const file = join(outside, "shot.png");
    writeFileSync(file, "x");
    expect(resolveImportSource(directory, file)).toBe(file);

    symlinkSync(file, join(directory, "link.png"));
    expect(() => resolveImportSource(directory, "link.png")).toThrowError(
      /outside the authorized workspace/,
    );
    expect(() => resolveImportSource(directory, outside)).toThrowError(
      /regular files/,
    );
    expect(() => resolveImportSource(directory, "")).toThrowError(/invalid/);
    rmSync(outside, { recursive: true, force: true });
  });

  it("sheds the verbatim prefix Windows answers with", () => {
    // Exercised on every platform; only Windows ever asks.
    expect(plainWin32Spelling("\\\\?\\C:\\Users\\dev")).toBe("C:\\Users\\dev");
    expect(plainWin32Spelling("\\\\?\\UNC\\server\\share")).toBeUndefined();
    expect(plainWin32Spelling("/home/dev")).toBeUndefined();
  });
});
