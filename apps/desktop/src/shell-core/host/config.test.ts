import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_ENDPOINT,
  type HostLaunchConfig,
  hostBinaryName,
  hostEndpoint,
  nativeOrigin,
  resolveBinary,
  startArguments,
  validate,
  validEndpoint,
  validOrigin,
} from "./config";

/**
 * The Rust shell's own assertions about the launch
 * line and its validation — the half that needs no process.
 */

const name = hostBinaryName("darwin");

function config(binary: string): HostLaunchConfig {
  return {
    binary,
    dataDir: undefined,
    browserOrigin: "http://127.0.0.1:54321",
    cliTimeoutMs: 15_000,
    endpointsDir: undefined,
    expectedHttpEndpoint: HOST_ENDPOINT,
  };
}

describe("binary resolution", () => {
  const base = join(tmpdir(), "armadra-host-path-test");
  const repo = join(base, "repo");
  /**
   * electron-builder's `extraResources` stages the four binaries here, which
   * is the same place `runtimeExecutable` looks. It used to be resolved beside
   * `process.execPath` (`Contents/MacOS/`) — where the Rust shell's sidecars
   * lived and where nothing is staged now, so a double-clicked application
   * found no Host at all.
   */
  const resources = join(base, "bundle/Contents/Resources");

  it("is explicit, and release ignores development overrides", () => {
    expect(
      resolveBinary(false, resources, repo, "wrong", "elsewhere", "darwin"),
    ).toEqual({
      ok: true,
      binary: join(resources, name),
    });
    // A resources path that is not absolute is a configuration error, not a
    // reason to fall back to something relative that `PATH` would resolve.
    expect(
      resolveBinary(false, "Resources", repo, undefined, undefined, "darwin"),
    ).toEqual({ ok: false, error: { kind: "invalidConfiguration" } });
    expect(
      resolveBinary(true, resources, repo, undefined, undefined, "darwin"),
    ).toEqual({
      ok: true,
      binary: join(repo, "target/debug", name),
    });
    // An empty CARGO_TARGET_DIR is not a target directory.
    expect(
      resolveBinary(true, resources, repo, undefined, "", "darwin"),
    ).toEqual({
      ok: true,
      binary: join(repo, "target/debug", name),
    });
    expect(
      resolveBinary(
        true,
        resources,
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
      resources,
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
      resolveBinary(true, resources, repo, explicit, undefined, "darwin"),
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
    // Exactly the page's own origin: nothing is granted that this shell did
    // not decide to serve from.
    expect(args.filter((arg) => arg === "--allow-origin")).toHaveLength(1);
    expect(args[args.indexOf("--allow-origin") + 1]).toBe(
      "http://127.0.0.1:1420",
    );
    // A directory with spaces is one argument, not two.
    expect(args.at(-1)).toBe(directory);
  });

  it("grants the page's origin once, not twice, when it is also an extra", () => {
    // `startArguments` de-duplicates through a Set: the Host refuses a
    // repeated --allow-origin, and a line that differs between two starts of
    // the same shell is one nobody can diff.
    const args = startArguments({
      ...config(join(tmpdir(), name)),
      additionalOrigins: ["http://127.0.0.1:54321"],
    });
    expect(args.filter((arg) => arg === "--allow-origin")).toHaveLength(1);
  });

  it("grants the shell's own kernel-assigned origin, once", () => {
    const shell: HostLaunchConfig = {
      ...config(join(tmpdir(), name)),
      browserOrigin: "http://127.0.0.1:54321",
      // Development also names apps/web's dev server, and a repeat of the
      // page's own origin must not become a second --allow-origin: the Host
      // refuses a repeated grant.
      additionalOrigins: ["http://127.0.0.1:1420", "http://127.0.0.1:54321"],
    };
    expect(validate(shell)).toBeUndefined();
    const granted = startArguments(shell)
      .map((arg, index, all) =>
        all[index - 1] === "--allow-origin" ? arg : null,
      )
      .filter((arg): arg is string => arg !== null);
    // The page's own origin first, then each additional one in the order it
    // was given. No constant is prepended any more, so what the Host is told
    // is exactly what this shell decided to serve from.
    expect(granted).toEqual([
      "http://127.0.0.1:54321",
      "http://127.0.0.1:1420",
    ]);
  });

  it("refuses an additional origin that is not one", () => {
    expect(
      validate({
        ...config(join(tmpdir(), name)),
        additionalOrigins: ["http://127.0.0.1:1420/app"],
      }),
    ).toEqual({ kind: "invalidConfiguration" });
  });
});

describe("where the Host listens", () => {
  it("is the documented port, and an installed shell cannot be redirected", () => {
    expect(hostEndpoint(true, undefined)).toBe(HOST_ENDPOINT);
    expect(hostEndpoint(true, "")).toBe(HOST_ENDPOINT);
    // A packaged application must not be redirectable by an environment
    // variable, the same rule `resolveBinary` applies to the binary.
    expect(hostEndpoint(false, "127.0.0.1:43171")).toBe(HOST_ENDPOINT);
  });

  it("lets a development shell stand beside an installed Armadra's Host", () => {
    expect(hostEndpoint(true, "127.0.0.1:43171")).toBe(
      "http://127.0.0.1:43171",
    );
    expect(hostEndpoint(true, "http://127.0.0.1:43171")).toBe(
      "http://127.0.0.1:43171",
    );
    expect(
      validate({
        ...config(join(tmpdir(), name)),
        expectedHttpEndpoint: hostEndpoint(true, "127.0.0.1:43171"),
      }),
    ).toBeUndefined();
  });

  it("refuses a malformed override rather than quietly picking something", () => {
    for (const override of ["not an endpoint", "0.0.0.0:43121", "127.0.0.1"]) {
      // Not the default (that would start a Host somewhere nobody asked for)
      // and not `undefined` (that means no listener at all) — a configuration
      // error, which `validate` is what reports.
      const endpoint = hostEndpoint(true, override);
      expect(endpoint, override).not.toBe(HOST_ENDPOINT);
      expect(endpoint, override).toBeDefined();
      expect(
        validate({
          ...config(join(tmpdir(), name)),
          expectedHttpEndpoint: endpoint,
        }),
        override,
      ).toEqual({ kind: "invalidConfiguration" });
    }
  });
});

describe("which origins a shell can present", () => {
  it("accepts any loopback HTTP origin", () => {
    // The same rule the Host applies in `native.go:loopbackHTTPOrigin` and the
    // page in `packages/host-client/src/native.ts`. All three have to agree on
    // the same string, or a ticket is minted for an origin that cannot spend
    // it; each side pins the table.
    for (const origin of [
      "http://127.0.0.1:54321",
      "http://127.0.0.1:1420",
      "http://127.5.5.5:8080",
      "http://localhost:3000",
      "http://[::1]:9000",
    ]) {
      expect(nativeOrigin(origin), origin).toBe(true);
    }
  });

  it("refuses anything that is not loopback, not HTTP, or not an origin", () => {
    for (const origin of [
      // HTTPS on loopback is a browser deployment, and its session is the
      // cookie one; only plain loopback HTTP is the shell shape (§2.1).
      "https://127.0.0.1:54321",
      "http://192.168.1.20:54321",
      "http://armadra.example",
      // A name that merely ends in something loopback-looking.
      "http://127.0.0.1.evil.example",
      "http://localhost.evil.example",
      // Not an origin at all.
      "http://127.0.0.1:54321/app",
      "http://user:pass@127.0.0.1:54321",
      "",
      "not a url",
    ]) {
      expect(nativeOrigin(origin), origin).toBe(false);
    }
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
  it("accepts well-formed http(s) origins", () => {
    for (const origin of [
      "http://127.0.0.1:54321",
      "http://127.0.0.1:1420",
      "http://localhost:3000",
      "https://example.test",
    ]) {
      expect(validOrigin(origin), origin).toBe(true);
    }
  });

  it("refuses a custom scheme, however local it looks", () => {
    // Nothing presents one any more, and the Host's own `--allow-origin`
    // parser rejects them too (`apps/host/internal/server/origin.go`). An
    // origin this shell cannot serve from is one a ticket could never be
    // spent on.
    for (const origin of [
      "tauri://localhost",
      "app://localhost",
      "armadra://localhost",
    ]) {
      expect(validOrigin(origin), origin).toBe(false);
      expect(nativeOrigin(origin), origin).toBe(false);
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
