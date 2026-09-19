import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_ENDPOINT,
  type HostLaunchConfig,
  hostBinaryName,
  resolveBinary,
  startArguments,
  validate,
  validEndpoint,
  validOrigin,
} from "./config";

/**
 * The assertion list of `src-tauri/src/host/tests.rs` that concerns the launch
 * line and its validation — the half that needs no process.
 */

const name = hostBinaryName("darwin");

function config(binary: string): HostLaunchConfig {
  return {
    binary,
    dataDir: undefined,
    browserOrigin: "tauri://localhost",
    cliTimeoutMs: 15_000,
    endpointsDir: undefined,
    expectedHttpEndpoint: HOST_ENDPOINT,
  };
}

describe("binary resolution", () => {
  const base = join(tmpdir(), "armadra-host-path-test");
  const repo = join(base, "repo");
  const executable = join(base, "bundle/desktop");

  it("is explicit, and release ignores development overrides", () => {
    expect(
      resolveBinary(false, executable, repo, "wrong", "elsewhere", "darwin"),
    ).toEqual({
      ok: true,
      binary: join(base, "bundle", name),
    });
    expect(
      resolveBinary(true, executable, repo, undefined, undefined, "darwin"),
    ).toEqual({
      ok: true,
      binary: join(repo, "target/debug", name),
    });
    // An empty CARGO_TARGET_DIR is not a target directory.
    expect(
      resolveBinary(true, executable, repo, undefined, "", "darwin"),
    ).toEqual({
      ok: true,
      binary: join(repo, "target/debug", name),
    });
    expect(
      resolveBinary(
        true,
        executable,
        repo,
        undefined,
        "custom-target",
        "darwin",
      ),
    ).toEqual({
      ok: true,
      binary: join(repo, "custom-target/debug", name),
    });
  });

  it("refuses a relative override rather than searching PATH", () => {
    const found = resolveBinary(
      true,
      executable,
      repo,
      "host-on-path",
      undefined,
      "darwin",
    );
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.error.kind).toBe("invalidConfiguration");
  });

  it("takes an absolute override verbatim", () => {
    const explicit = join(base, "custom-host");
    expect(
      resolveBinary(true, executable, repo, explicit, undefined, "darwin"),
    ).toEqual({
      ok: true,
      binary: explicit,
    });
  });
});

describe("the start line", () => {
  it("is fixed, and no option is shell-parsed", () => {
    const directory = join(tmpdir(), "host data with spaces");
    const withData: HostLaunchConfig = {
      ...config(join(tmpdir(), name)),
      browserOrigin: "http://127.0.0.1:1420",
      dataDir: directory,
    };
    expect(validate(withData)).toBeUndefined();
    const args = startArguments(withData);
    expect(args.slice(0, 7)).toEqual([
      "start",
      "--output",
      "protobuf",
      // The Host records who started it, so a desktop update stops only the
      // Host this shell owns (design §3.4).
      "--launcher",
      "desktop",
      "--listen",
      "127.0.0.1:43121",
    ]);
    // Three native origins plus the page's own, which is not one of them.
    expect(args.filter((arg) => arg === "--allow-origin")).toHaveLength(4);
    // A directory with spaces is one argument, not two.
    expect(args.at(-1)).toBe(directory);
  });

  it("grants only the three native origins when the page is already one", () => {
    const args = startArguments(config(join(tmpdir(), name)));
    expect(args.filter((arg) => arg === "--allow-origin")).toHaveLength(3);
  });

  it("asks for no listener and grants no origin when there is no endpoint", () => {
    const shared = join(tmpdir(), "armadra shared endpoints");
    const portless: HostLaunchConfig = {
      ...config(join(tmpdir(), name)),
      expectedHttpEndpoint: undefined,
      endpointsDir: shared,
    };
    expect(validate(portless)).toBeUndefined();
    expect(startArguments(portless)).toEqual([
      "start",
      "--output",
      "protobuf",
      "--launcher",
      "desktop",
      "--listen",
      "none",
      "--endpoints-dir",
      shared,
    ]);
    expect(
      startArguments(portless).some((arg) => arg === "--allow-origin"),
    ).toBe(false);
  });
});

describe("configuration validation", () => {
  const base = config(join(tmpdir(), name));

  it("refuses an origin that is really a URL", () => {
    expect(
      validate({ ...base, browserOrigin: "https://host.test/path?secret=x" })
        ?.kind,
    ).toBe("invalidConfiguration");
  });

  it("refuses an endpoint that is not loopback", () => {
    expect(
      validate({ ...base, expectedHttpEndpoint: "http://0.0.0.0:43121" })?.kind,
    ).toBe("invalidConfiguration");
  });

  it("refuses a relative shared-endpoints directory", () => {
    // It would resolve against whatever the working directory happens to be.
    expect(validate({ ...base, endpointsDir: "relative" })?.kind).toBe(
      "invalidConfiguration",
    );
  });

  it("refuses a relative data directory and a relative binary", () => {
    expect(validate({ ...base, dataDir: "relative" })?.kind).toBe(
      "invalidConfiguration",
    );
    expect(validate({ ...base, binary: "armadra-host" })?.kind).toBe(
      "invalidConfiguration",
    );
  });

  it("bounds the CLI timeout at both ends", () => {
    expect(validate({ ...base, cliTimeoutMs: 0 })?.kind).toBe(
      "invalidConfiguration",
    );
    expect(validate({ ...base, cliTimeoutMs: 15_001 })?.kind).toBe(
      "invalidConfiguration",
    );
    expect(validate({ ...base, cliTimeoutMs: 1 })).toBeUndefined();
  });
});

describe("origin and endpoint shapes", () => {
  it("accepts the native origins and well-formed http(s) origins", () => {
    for (const origin of [
      "tauri://localhost",
      "http://tauri.localhost",
      "https://tauri.localhost",
      "http://127.0.0.1:1420",
      "https://example.test",
    ]) {
      expect(validOrigin(origin), origin).toBe(true);
    }
  });

  it("refuses anything carrying more than a scheme, host and port", () => {
    for (const origin of [
      "https://host.test/path?secret=x",
      "https://user:pw@host.test",
      "ftp://host.test",
      "not a url",
      "",
    ]) {
      expect(validOrigin(origin), origin).toBe(false);
    }
  });

  it("requires a Host endpoint to be loopback http with a port", () => {
    expect(validEndpoint("http://127.0.0.1:43121")).toBe(true);
    for (const endpoint of [
      "http://0.0.0.0:43121",
      "https://127.0.0.1:43121",
      "http://127.0.0.1",
      "http://localhost:43121",
      "http://127.0.0.1:43121/rpc",
      "",
    ]) {
      expect(validEndpoint(endpoint), endpoint).toBe(false);
    }
  });
});
