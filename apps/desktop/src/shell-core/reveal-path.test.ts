import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";

import { isInsideRoot, revealablePath } from "./reveal-path";

/**
 * The allow-list `shell:show-item-in-folder` is behind. Every case here is a
 * path the page could name, because the page is exactly who names it.
 *
 * Paths are written in posix spelling and compared through `resolve`, so the
 * suite says the same thing on Windows, where the same strings resolve onto
 * the current drive.
 */

const DATA = resolve("/data/Armadra");
const DOWNLOADS = resolve("/home/somebody/Downloads");
const ROOTS = [DATA, DOWNLOADS];

describe("the root test", () => {
  it("accepts the root itself and what is inside it", () => {
    expect(isInsideRoot(DATA, DATA)).toBe(true);
    expect(isInsideRoot(DATA, join(DATA, "armadra.db"))).toBe(true);
  });

  it("does not accept a sibling whose name starts the same way", () => {
    // `/data/Armadra-evil` starts with `/data/Armadra`; a plain `startsWith`
    // is the bug this separator-terminated prefix exists to prevent.
    expect(isInsideRoot(DATA, `${DATA}-evil`)).toBe(false);
  });
});

describe("the path a reveal may open", () => {
  it("returns the normalized path for the data directory and its contents", () => {
    expect(revealablePath(DATA, ROOTS)).toBe(DATA);
    expect(revealablePath(join(DATA, "armadra.db"), ROOTS)).toBe(
      join(DATA, "armadra.db"),
    );
  });

  it("returns the normalized path for the downloads directory", () => {
    expect(revealablePath(join(DOWNLOADS, "report.pdf"), ROOTS)).toBe(
      join(DOWNLOADS, "report.pdf"),
    );
  });

  it("collapses `..` before deciding, and answers with what it checked", () => {
    // The returned value is the one the caller hands to Electron, so the
    // checked form and the used form cannot drift apart.
    const climbed = join(DATA, "nested", "..", "armadra.db");
    expect(revealablePath(climbed, ROOTS)).toBe(join(DATA, "armadra.db"));
  });

  it("refuses a path that climbs out of every root", () => {
    expect(revealablePath(join(DATA, "..", "..", "etc", "passwd"), ROOTS)).toBe(
      null,
    );
    expect(revealablePath(resolve("/etc/passwd"), ROOTS)).toBe(null);
    expect(revealablePath(`${DATA}-evil`, ROOTS)).toBe(null);
  });

  it("refuses anything that is not an absolute path string", () => {
    for (const value of ["", "relative/path", ".", 42, null, undefined, {}])
      expect(revealablePath(value, ROOTS), JSON.stringify(value)).toBe(null);
  });

  it("refuses a path carrying a NUL byte", () => {
    // The syscall truncates at the NUL, so the checked string and the opened
    // one would be different paths.
    expect(revealablePath(`${join(DATA, "ok")}\0/etc/passwd`, ROOTS)).toBe(
      null,
    );
  });

  it("refuses everything when there are no roots, and ignores junk roots", () => {
    expect(revealablePath(DATA, [])).toBe(null);
    expect(revealablePath(DATA, ["", "relative"])).toBe(null);
  });
});
