import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import {
  goTarget,
  hostBuildPlan,
  rustSidecars,
  selectTarget,
  sidecarPaths,
} from "./sidecar-targets.mjs";
import { parseArguments } from "./prepare-host.mjs";
import { main as sidecarMain } from "./prepare-sidecar.mjs";

const host = "aarch64-apple-darwin";
const repository = resolve("/project with spaces/Armadra");

test("imports expose entrypoints without running a build", () => {
  assert.equal(typeof sidecarMain, "function");
});

test("explicit supported Rust triples map to Go OS and architecture", () => {
  for (const [triple, GOOS, GOARCH] of [
    ["aarch64-apple-darwin", "darwin", "arm64"],
    ["x86_64-apple-darwin", "darwin", "amd64"],
    ["aarch64-unknown-linux-gnu", "linux", "arm64"],
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
  assert.deepEqual(
    selectTarget({ host, env: { TAURI_ENV_TARGET_TRIPLE: host } }),
    { triple: host, explicitTarget: false },
  );
  const env = {
    CARGO_BUILD_TARGET: "x86_64-apple-darwin",
    TAURI_ENV_TARGET_TRIPLE: "x86_64-pc-windows-msvc",
  };
  assert.equal(selectTarget({ host, env }).triple, env.TAURI_ENV_TARGET_TRIPLE);
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
  assert.equal(
    plan.destination,
    resolve(repository, `target/release/armadra-host-${host}`),
  );
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

test("custom Cargo target directory changes source but not Tauri staging", () => {
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
    assert.equal(
      plan.destination,
      resolve(repository, `target/release/armadra-host-${target.triple}.exe`),
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

test("the Windows session host is staged with the target triple in its name", () => {
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
  assert.equal(
    paths.destination,
    resolve(
      repository,
      `target/release/armadra-session-host-${target.triple}.exe`,
    ),
  );
});
