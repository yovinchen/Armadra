import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { isInside, jailReadPath, jailWritePath } from "./workspace-path";

/**
 * The jail, against a real filesystem.
 *
 * `realpath` and `lstat` are the whole point of these checks, so the cases are
 * built out of real directories, real symlinks and a real sibling whose name
 * shares a prefix with the workspace.
 */

let root = "";
let workspace = "";
let outside = "";

beforeAll(() => {
  // `realpath` up front: on macOS a temporary directory is reached through
  // /tmp, which is itself a symlink to /private/tmp, and a test that compared
  // an unresolved root against a resolved answer would fail for the wrong
  // reason on one platform only.
  root = realpathSync(mkdtempSync(join(tmpdir(), "armadra-jail-")));
  workspace = join(root, "proj");
  outside = join(root, "elsewhere");
  mkdirSync(join(workspace, "shots"), { recursive: true });
  // The sibling whose name STARTS WITH the workspace's: a plain `startsWith`
  // prefix comparison lets this one through.
  mkdirSync(join(root, "proj-evil"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "s");
  writeFileSync(join(workspace, "real.txt"), "r");
  symlinkSync(join(outside, "secret.txt"), join(workspace, "escape.txt"));
  symlinkSync(outside, join(workspace, "escape-dir"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("isInside", () => {
  it("accepts the root itself and things under it", () => {
    expect(isInside("/a/proj", "/a/proj")).toBe(true);
    expect(isInside("/a/proj", `/a/proj${sep}x`)).toBe(true);
  });

  it("refuses a sibling that merely shares the prefix", () => {
    expect(isInside("/a/proj", "/a/proj-evil/x")).toBe(false);
    expect(isInside("/a/proj", "/a/projx")).toBe(false);
  });
});

describe("a path a capture may write", () => {
  it("takes a relative path inside the workspace", () => {
    const jailed = jailWritePath(workspace, "shots/page.png");
    expect(jailed.ok).toBe(true);
    if (jailed.ok) expect(jailed.path).toBe(join(workspace, "shots", "page.png"));
  });

  it("refuses a path that climbs out with ..", () => {
    const jailed = jailWritePath(workspace, "../elsewhere/page.png");
    expect(jailed).toEqual({ ok: false, reason: "outsideWorkspace" });
  });

  it("refuses an absolute path outside the workspace", () => {
    expect(jailWritePath(workspace, join(outside, "page.png"))).toEqual({
      ok: false,
      reason: "outsideWorkspace",
    });
  });

  it("refuses a sibling directory whose name shares the prefix", () => {
    expect(jailWritePath(workspace, join(root, "proj-evil", "page.png"))).toEqual({
      ok: false,
      reason: "outsideWorkspace",
    });
  });

  it("refuses a symlinked directory in the middle of the path", () => {
    expect(jailWritePath(workspace, "escape-dir/page.png")).toEqual({
      ok: false,
      reason: "outsideWorkspace",
    });
  });

  it("refuses a symlink as the FINAL segment, which realpath of the parent misses", () => {
    expect(jailWritePath(workspace, "escape.txt")).toEqual({ ok: false, reason: "symlink" });
  });

  it("refuses a path carrying a NUL byte", () => {
    expect(jailWritePath(workspace, "shots/a\0b.png")).toEqual({ ok: false, reason: "badPath" });
  });

  it("refuses a directory that does not exist rather than creating one", () => {
    expect(jailWritePath(workspace, "nope/page.png")).toEqual({
      ok: false,
      reason: "missingParent",
    });
  });
});

describe("a path an upload may read", () => {
  it("takes a real file inside the workspace", () => {
    expect(jailReadPath(workspace, "real.txt").ok).toBe(true);
  });

  it("refuses a symlink pointing out, and refuses a file that is not there", () => {
    expect(jailReadPath(workspace, "escape.txt").ok).toBe(false);
    expect(jailReadPath(workspace, "real-missing.txt").ok).toBe(false);
  });

  it("refuses a directory", () => {
    expect(jailReadPath(workspace, "shots")).toEqual({ ok: false, reason: "badPath" });
  });
});
