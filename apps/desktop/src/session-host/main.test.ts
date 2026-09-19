import { describe, expect, it } from "vitest";
import { USAGE, parseArguments, run } from "./main";

/**
 * The command line, which is the one interface of this program that a person
 * types and that every process on the machine can read.
 *
 * One argument, no options. The rule is not style: `ps` and Task Manager show
 * a command line to anybody, so a session key, a token or a pipe name on it
 * would be a leak with no way back. Everything is derived from the data
 * directory instead, and a second argument is **refused** rather than ignored
 * so a caller that thought it was passing an option finds out immediately
 * instead of running a host that quietly disagrees with it.
 */

describe("the command line", () => {
  it("takes exactly one data directory", () => {
    expect(parseArguments(["C:\\Users\\a\\AppData\\Local\\armadra"])).toEqual({
      ok: true,
      dataDir: "C:\\Users\\a\\AppData\\Local\\armadra",
    });
  });

  it("refuses to run with no arguments", () => {
    expect(parseArguments([])).toEqual({ ok: false, reason: USAGE });
  });

  it("refuses more than one argument rather than ignoring the rest", () => {
    const parsed = parseArguments(["C:\\data", "--idle-exit-minutes", "0"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toContain("3");
  });

  /**
   * An empty path would resolve to this process' working directory, which is
   * wherever the core happened to be — a host silently serving a different
   * data directory than the one asked for.
   */
  it("refuses an empty data directory", () => {
    expect(parseArguments([""]).ok).toBe(false);
    expect(parseArguments(["   "]).ok).toBe(false);
  });

  it("refuses something that looks like an option", () => {
    const parsed = parseArguments(["--help"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toContain("选项");
  });
});

describe("run", () => {
  /**
   * A stub that pretended to work off Windows would be worse than one that
   * says what it is: on Unix the terminal domain has tmux and the direct
   * backend, and a session host there would be a second, silent answer to a
   * question already answered.
   */
  it("refuses to start anywhere but Windows, before touching the data directory", async () => {
    const lines: string[] = [];
    await expect(
      run({
        argv: ["/nonexistent/armadra"],
        platform: "darwin",
        log: (line) => lines.push(line),
      }),
    ).resolves.toBe(2);
    expect(lines.join("\n")).toContain("只在 Windows 上运行");
  });

  it("reports a bad command line with the usage exit code", async () => {
    const lines: string[] = [];
    await expect(
      run({ argv: [], platform: "win32", log: (line) => lines.push(line) }),
    ).resolves.toBe(2);
    expect(lines.join("\n")).toContain(USAGE);
  });
});
