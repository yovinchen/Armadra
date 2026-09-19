import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import {
  bundleResources,
  goTarget,
  hostBuildPlan,
  rustSidecars,
  selectTarget,
  sidecarPaths,
} from "./sidecar-targets.mjs";
import { parseArguments } from "./prepare-host.mjs";

const host = "aarch64-apple-darwin";
const repository = resolve("/project with spaces/Armadra");

test("explicit supported Rust triples map to Go OS and architecture", () => {
  // Every triple the release matrix names has to be in here, or the packaging
  // job discovers it at tag time.
  for (const [triple, GOOS, GOARCH] of [
    ["aarch64-apple-darwin", "darwin", "arm64"],
    ["x86_64-apple-darwin", "darwin", "amd64"],
    ["aarch64-unknown-linux-gnu", "linux", "arm64"],
    ["x86_64-unknown-linux-gnu", "linux", "amd64"],
    ["aarch64-unknown-linux-musl", "linux", "arm64"],
    ["x86_64-unknown-linux-musl", "linux", "amd64"],
    ["aarch64-pc-windows-msvc", "windows", "arm64"],
    ["x86_64-pc-windows-msvc", "windows", "amd64"],
    ["x86_64-pc-windows-gnu", "windows", "amd64"],
  ])
    assert.deepEqual(goTarget(triple), {
      GOOS,
      GOARCH,
      extension: GOOS === "windows" ? ".exe" : "",
    });
  for (const invalid of [
    "",
    "windows",
    "x86_64-linux",
    "riscv64gc-unknown-linux-gnu",
    "aarch64-apple-ios",
    "../../windows",
    "constructor",
  ]) {
    assert.throws(() => goTarget(invalid), /Unsupported Host target/);
  }
});

test("target selection preserves Cargo behavior and native dev override", () => {
  assert.deepEqual(selectTarget({ host }), {
    triple: host,
    explicitTarget: false,
  });
  assert.deepEqual(selectTarget({ host, env: { CARGO_BUILD_TARGET: host } }), {
    triple: host,
    explicitTarget: true,
  });
  const env = { CARGO_BUILD_TARGET: "x86_64-apple-darwin" };
  assert.equal(selectTarget({ host, env }).triple, env.CARGO_BUILD_TARGET);
  assert.equal(
    selectTarget({ host, env, target: "x86_64-unknown-linux-gnu" }).triple,
    "x86_64-unknown-linux-gnu",
  );
  assert.deepEqual(selectTarget({ host, env, native: true }), {
    triple: host,
    explicitTarget: false,
  });
  assert.throws(
    () => selectTarget({ host, target: host, native: true }),
    /cannot be combined/,
  );
  assert.throws(
    () => selectTarget({ host, env: { CARGO_BUILD_TARGET: "unknown" } }),
    /Unsupported/,
  );
});

test("native debug paths and spaces are preserved as a single argv item", () => {
  const target = selectTarget({ host });
  const plan = hostBuildPlan({
    repository,
    target,
    env: { GOOS: "wrong", GOARCH: "wrong", CGO_ENABLED: "1" },
  });
  assert.equal(plan.source, resolve(repository, "target/debug/armadra-host"));
  assert.equal(plan.args[plan.args.indexOf("-o") + 1], plan.source);
  assert.equal(plan.cwd, resolve(repository, "apps/host"));
  assert.equal(plan.env.CGO_ENABLED, "0");
  assert.equal(plan.env.GOOS, "darwin");
  assert.equal(plan.env.GOARCH, "arm64");
  assert.equal(plan.env.GOTOOLCHAIN, "local");
  assert.equal(
    plan.env.GOCACHE,
    resolve(repository, "target/protocol-go/build"),
  );
});

test("custom Cargo target directory moves the built binary with it", () => {
  for (const directory of [
    "custom target",
    resolve("/another target location"),
  ]) {
    const env = { CARGO_TARGET_DIR: directory };
    const target = selectTarget({ host, target: "x86_64-pc-windows-msvc" });
    const plan = hostBuildPlan({ repository, env, target, release: true });
    assert.equal(
      plan.source,
      resolve(repository, directory, target.triple, "release/armadra-host.exe"),
    );
    assert.equal(plan.env.GOOS, "windows");
    assert.ok(plan.args.includes("-ldflags=-s -w"));
    const runtime = sidecarPaths({
      repository,
      env,
      target,
      binary: "armadra-runtime",
    });
    assert.equal(
      runtime.source,
      resolve(
        repository,
        directory,
        target.triple,
        "release/armadra-runtime.exe",
      ),
    );
  }
});

test("host CLI options reject unsupported combinations or incomplete values", () => {
  assert.deepEqual(parseArguments(["--native"]), {
    native: true,
    release: false,
  });
  assert.deepEqual(parseArguments(["--release", "--target", host]), {
    native: false,
    release: true,
    target: host,
  });
  for (const args of [
    ["--target"],
    ["--target", "--release"],
    ["--unknown"],
    ["--native", "--target", host],
  ])
    assert.throws(() => parseArguments(args));
});

test("the session host ships on Windows targets only", () => {
  for (const triple of [
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
    "x86_64-pc-windows-gnu",
  ]) {
    const binaries = rustSidecars(triple).map((sidecar) => sidecar.binary);
    assert.deepEqual(binaries, [
      "armadra-runtime",
      "armadra-hook",
      "armadra-session-host",
    ]);
  }
  // Elsewhere tmux already keeps sessions alive; a binary whose main refuses
  // to run has no business in the bundle.
  for (const triple of [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-musl",
  ]) {
    const binaries = rustSidecars(triple).map((sidecar) => sidecar.binary);
    assert.deepEqual(binaries, ["armadra-runtime", "armadra-hook"]);
  }
  assert.throws(
    () => rustSidecars("riscv64gc-unknown-linux-gnu"),
    /Unsupported/,
  );
});

test("the Windows session host is found under the target triple directory", () => {
  const target = selectTarget({ host, target: "x86_64-pc-windows-msvc" });
  const paths = sidecarPaths({
    repository,
    target,
    binary: "armadra-session-host",
  });
  assert.equal(
    paths.source,
    resolve(
      repository,
      "target",
      target.triple,
      "release/armadra-session-host.exe",
    ),
  );
  assert.equal(paths.destination, undefined);
});

/**
 * `bundleResources()` is what `after-pack.mjs` places; nothing may travel as
 * an `extraResources` entry any more, because electron-builder's one-shot
 * copy is exactly what the hook exists to replace. A `{from, to}` pair that
 * crept back into the yml would be a file copied without a retry — and, on
 * the Windows runners, a build that fails one time in three.
 */
const here = dirname(fileURLToPath(import.meta.url));
const BUILDER = load(
  readFileSync(join(here, "..", "electron-builder.yml"), "utf8"),
);

test("no platform section lists extraResources; after-pack.mjs places the bundles", async () => {
  for (const platform of ["win", "mac", "linux"]) {
    assert.equal(
      BUILDER[platform].extraResources,
      undefined,
      `${platform}: extraResources is back in electron-builder.yml`,
    );
  }
  assert.equal(BUILDER.afterPack, "./scripts/after-pack.mjs");
  const { placements } = await import("./after-pack.mjs");
  for (const triple of [
    "x86_64-pc-windows-msvc",
    "aarch64-apple-darwin",
    "x86_64-unknown-linux-gnu",
  ]) {
    const placed = placements(triple).map((p) => `${p.from} -> ${p.to}`);
    for (const bundle of bundleResources(triple)) {
      assert.ok(
        placed.includes(`${bundle.from} -> ${bundle.to}`),
        `${triple}: after-pack never places ${bundle.from}`,
      );
    }
  }
});

test("the session host bundle ships on Windows only", () => {
  const windows = bundleResources("x86_64-pc-windows-msvc").map((b) => b.from);
  assert.ok(windows.includes("out/session-host/host.cjs"));
  for (const triple of ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"]) {
    const elsewhere = bundleResources(triple).map((bundle) => bundle.from);
    assert.deepEqual(elsewhere, ["out/cli/armadra-hook.js"]);
  }
});

/**
 * The daemon must not end up in the asar: it is named on a command line as an
 * absolute path, and only a real file on disk can be.
 */
test("neither bundle is left inside the asar", () => {
  for (const pattern of ["!out/cli/**/*", "!out/session-host/**/*"]) {
    assert.ok(
      BUILDER.files.includes(pattern),
      `electron-builder.yml's "files" is missing ${pattern}`,
    );
  }
});
