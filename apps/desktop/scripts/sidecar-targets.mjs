import { resolve } from "node:path";

// Exact supported Rust target spellings. Do not infer an OS from a substring.
const targets = new Map([
  ["aarch64-apple-darwin", ["darwin", "arm64"]],
  ["x86_64-apple-darwin", ["darwin", "amd64"]],
  ["aarch64-unknown-linux-gnu", ["linux", "arm64"]],
  ["x86_64-unknown-linux-gnu", ["linux", "amd64"]],
  ["aarch64-unknown-linux-musl", ["linux", "arm64"]],
  ["x86_64-unknown-linux-musl", ["linux", "amd64"]],
  ["aarch64-pc-windows-msvc", ["windows", "arm64"]],
  ["x86_64-pc-windows-msvc", ["windows", "amd64"]],
  ["x86_64-pc-windows-gnu", ["windows", "amd64"]],
]);

export function goTarget(triple) {
  const target = targets.get(triple);
  if (!target) throw new Error(`Unsupported Host target triple: ${triple}`);
  return {
    GOOS: target[0],
    GOARCH: target[1],
    extension: target[0] === "windows" ? ".exe" : "",
  };
}

export function selectTarget({ host, env = {}, target, native = false }) {
  if (!host) throw new Error("Could not determine the Rust host target triple");
  if (native && target)
    throw new Error("--native and --target cannot be combined");
  const triple = native
    ? host
    : target || env.TAURI_ENV_TARGET_TRIPLE || env.CARGO_BUILD_TARGET || host;
  goTarget(triple); // Fail before invoking either toolchain on unsupported targets.
  return {
    triple,
    explicitTarget:
      !native && (triple !== host || Boolean(target || env.CARGO_BUILD_TARGET)),
  };
}

export function targetDirectory(repository, env = {}) {
  return resolve(repository, env.CARGO_TARGET_DIR || "target");
}

export function sidecarPaths({
  repository,
  env = {},
  target,
  binary,
  release = true,
}) {
  const { extension } = goTarget(target.triple);
  return {
    source: resolve(
      targetDirectory(repository, env),
      target.explicitTarget ? target.triple : "",
      release ? "release" : "debug",
      `${binary}${extension}`,
    ),
    // Tauri's externalBin path is relative to tauri.conf.json, independent of
    // Cargo's optional output directory. Stage into that configured location.
    destination: resolve(
      repository,
      "target/release",
      `${binary}-${target.triple}${extension}`,
    ),
  };
}

export function hostBuildPlan({
  repository,
  env = {},
  target,
  release = false,
}) {
  const mapped = goTarget(target.triple);
  const paths = sidecarPaths({
    repository,
    env,
    target,
    binary: "armadra-host",
    release,
  });
  return {
    ...paths,
    command: env.ARMADRA_GO_BINARY || "go",
    args: [
      "build",
      "-mod=readonly",
      "-trimpath",
      ...(release ? ["-ldflags=-s -w"] : []),
      "-o",
      paths.source,
      "./cmd/armadra-host",
    ],
    cwd: resolve(repository, "apps/host"),
    env: {
      ...env,
      GOOS: mapped.GOOS,
      GOARCH: mapped.GOARCH,
      CGO_ENABLED: "0",
      GOTOOLCHAIN: "local",
      GOPATH: resolve(repository, "target/protocol-go/path"),
      GOMODCACHE: resolve(repository, "target/protocol-go/mod"),
      GOCACHE: resolve(repository, "target/protocol-go/build"),
    },
  };
}
