import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir, endpointsFile } from "./paths";

/**
 * The resolution has to agree with `apps/runtime/src/paths.rs` on every
 * platform, not just the one the test happens to run on — the two processes
 * find each other's socket by computing the same path independently.
 */
describe("data directory", () => {
  it("matches the Runtime on each platform", () => {
    expect(dataDir("darwin", { HOME: "/Users/x" })).toBe(
      "/Users/x/Library/Application Support/Armadra",
    );
    expect(
      dataDir("win32", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }),
    ).toBe(join("C:\\Users\\x\\AppData\\Local", "Armadra"));
    expect(dataDir("linux", { XDG_DATA_HOME: "/home/x/.data" })).toBe(
      "/home/x/.data/armadra",
    );
    expect(dataDir("linux", { HOME: "/home/x" })).toBe(
      "/home/x/.local/share/armadra",
    );
  });

  it("lets ARMADRA_DATA_DIR win everywhere, unmodified", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      expect(
        dataDir(platform, {
          ARMADRA_DATA_DIR: "/tmp/isolated",
          HOME: "/Users/x",
          LOCALAPPDATA: "C:\\Local",
          XDG_DATA_HOME: "/home/x/.data",
        }),
      ).toBe("/tmp/isolated");
    }
  });

  it("falls through when the platform's own variable is missing", () => {
    // No HOME on macOS is not "guess the home directory"; it is the same
    // last-resort branch the Rust side takes.
    expect(dataDir("darwin", {})).toBe(join(tmpdir(), "armadra"));
    expect(dataDir("win32", {})).toBe(join(tmpdir(), "armadra"));
    expect(dataDir("linux", {})).toBe(join(tmpdir(), "armadra"));
  });

  it("puts endpoints.json inside it", () => {
    expect(endpointsFile("darwin", { HOME: "/Users/x" })).toBe(
      "/Users/x/Library/Application Support/Armadra/endpoints.json",
    );
  });
});
