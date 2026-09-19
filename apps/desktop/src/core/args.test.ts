import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, USAGE, parseArguments } from "./args";

const NOTHING: NodeJS.ProcessEnv = {};

function run(argv: string[], env: NodeJS.ProcessEnv = NOTHING) {
  return parseArguments(argv, env);
}

describe("core arguments", () => {
  it("falls back to the documented loopback port when nobody said", () => {
    const parsed = run([]);
    expect(parsed).toEqual({
      kind: "run",
      args: {
        listen: [{ kind: "tcp", host: "127.0.0.1", port: DEFAULT_PORT }],
        dataDir: undefined,
        desktopControlStdin: false,
      },
    });
  });

  it("takes the host and port overrides", () => {
    const parsed = run([], {
      ARMADRA_RUNTIME_HOST: "127.0.0.2",
      ARMADRA_RUNTIME_PORT: "9",
    });
    expect(parsed.kind === "run" && parsed.args.listen).toEqual([
      { kind: "tcp", host: "127.0.0.2", port: 9 },
    ]);
  });

  it("refuses a port override that is not a port", () => {
    expect(run([], { ARMADRA_RUNTIME_PORT: "http" })).toEqual({
      kind: "error",
      reason: "ARMADRA_RUNTIME_PORT must be a valid port",
    });
  });

  it("refuses a host override that is not an address", () => {
    const parsed = run([], { ARMADRA_RUNTIME_HOST: "example.com" });
    expect(parsed.kind).toBe("error");
  });

  it("repeats --listen and replaces the default", () => {
    const parsed = run([
      "--desktop-control-stdin",
      "--listen",
      "unix:/tmp/armadra/runtime.sock",
      "--listen=tcp:127.0.0.1:0",
    ]);
    expect(parsed).toEqual({
      kind: "run",
      args: {
        listen: [
          { kind: "unix", path: "/tmp/armadra/runtime.sock" },
          { kind: "tcp", host: "127.0.0.1", port: 0 },
        ],
        dataDir: undefined,
        desktopControlStdin: true,
      },
    });
  });

  it("takes the data directory either spelling, once", () => {
    expect(
      run(["--data-dir", "/tmp/a"]).kind === "run" &&
        (run(["--data-dir", "/tmp/a"]) as { args: { dataDir: string } }).args
          .dataDir,
    ).toBe("/tmp/a");
    expect(
      (run(["--data-dir=/tmp/b"]) as { args: { dataDir: string } }).args
        .dataDir,
    ).toBe("/tmp/b");
    expect(run(["--data-dir", "/tmp/a", "--data-dir", "/tmp/b"])).toEqual({
      kind: "error",
      reason: "--data-dir may only be given once",
    });
  });

  it("asks for help without starting anything", () => {
    expect(run(["--help"])).toEqual({ kind: "help" });
    expect(run(["-h"])).toEqual({ kind: "help" });
    expect(USAGE).toContain("--listen");
    expect(USAGE).toContain("--data-dir");
  });

  it("refuses unknown or incomplete arguments", () => {
    for (const argv of [
      ["--listen"],
      ["--listen", "smtp:127.0.0.1:25"],
      ["--listen=unix:relative.sock"],
      ["--listen="],
      ["--data-dir"],
      ["--serve-everything"],
      ["extra"],
    ]) {
      expect(run(argv).kind, argv.join(" ")).toBe("error");
    }
  });

  it("accepts the desktop control flag the orphan sweep looks for", () => {
    const parsed = run(["--desktop-control-stdin"]);
    expect(parsed.kind === "run" && parsed.args.desktopControlStdin).toBe(true);
  });
});
