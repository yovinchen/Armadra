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

/**
 * The Rust sidecars a given target needs.
 *
 * `armadra-session-host` is Windows-only (T01): it owns the ConPTY sessions
 * that have to outlive the Worker and the shell. On macOS and Linux tmux
 * already does that job, and shipping a binary whose `main` refuses to run
 * would only make the bundle bigger and the story less clear.
 */
export function rustSidecars(triple) {
  const { GOOS } = goTarget(triple);
  const sidecars = [
    { package: "armadra-runtime", binary: "armadra-runtime" },
    { package: "armadra-hook", binary: "armadra-hook" },
  ];
  if (GOOS === "windows")
    sidecars.push({
      package: "armadra-session-host",
      binary: "armadra-session-host",
    });
  return sidecars;
}

/**
 * The electron-vite bundles a given target ships through `extraResources`.
 *
 * Not binaries, and therefore not `stage-binaries.mjs`' business: they are
 * produced by `pnpm --filter @armadra/desktop build` into `out/` and copied
 * from there verbatim. They are listed here, beside `rustSidecars()`, because
 * the question they answer is the same one — *what does this platform's
 * bundle have to contain* — and because a list nothing checks drifts.
 * `sidecar-targets.test.mjs` holds this against `electron-builder.yml`.
 *
 * `out/session-host/host.cjs` is Windows-only for the same reason
 * `armadra-session-host` is: ConPTY sessions have to outlive the shell there,
 * and tmux already does that job on macOS and Linux (R6d).
 */
export function bundleResources(triple) {
  const { GOOS } = goTarget(triple);
  const resources = [
    { from: "out/cli/armadra-hook.js", to: "cli/armadra-hook.js" },
  ];
  if (GOOS === "windows")
    resources.push({
      from: "out/session-host/host.cjs",
      to: "session-host/host.cjs",
    });
  return resources;
}

export function selectTarget({ host, env = {}, target, native = false }) {
  if (!host) throw new Error("Could not determine the Rust host target triple");
  if (native && target)
    throw new Error("--native and --target cannot be combined");
  const triple = native ? host : target || env.CARGO_BUILD_TARGET || host;
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

/**
 * Where a built binary is, as Cargo and `go build` leave it.
 *
 * There is no second, staged location: electron-builder's `extraResources`
 * copies files verbatim, so `stage-binaries.mjs` reads straight from here into
 * `apps/desktop/resources/` under the binary's plain name.
 */
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
