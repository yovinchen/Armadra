#!/usr/bin/env node
/**
 * Makes `node-pty` runnable before anything spawns a PTY.
 *
 * Two levels, because two audiences:
 *
 *   * `pnpm test` (vitest under Node) only needs the module's own prebuild —
 *     it is N-API, so Node loads it as-is. What pnpm's extraction loses is the
 *     executable bit on `spawn-helper`, and a helper that cannot be exec'd
 *     fails every spawn with `posix_spawnp failed.`, a message that names
 *     neither the file nor the permission. `--prebuilt` restores the bit and
 *     stops there: no compiler, no network, milliseconds.
 *   * `pnpm dev` / `dist` (Electron) need the patched source compiled for
 *     Electron's ABI and this machine's architecture: `--rebuild` runs
 *     `patch-node-pty.mjs` and `electron-rebuild --arch`, then checks the
 *     produced binaries with `file(1)`.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const app = join(here, "..");
const require = createRequire(import.meta.url);

export function nodePtyDir() {
  return dirname(require.resolve("node-pty/package.json", { paths: [app] }));
}

/** Restores the executable bit on every shipped `spawn-helper`. */
export function ensurePrebuiltExecutable(root = nodePtyDir()) {
  const prebuilds = join(root, "prebuilds");
  if (!existsSync(prebuilds)) return [];
  const fixed = [];
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, "spawn-helper");
    if (!existsSync(helper)) continue;
    const mode = statSync(helper).mode & 0o777;
    if ((mode & 0o111) !== 0o111) {
      chmodSync(helper, mode | 0o755);
      fixed.push(helper);
    }
  }
  // A compiled build, when present, ships its own helper too.
  const built = join(root, "build/Release/spawn-helper");
  if (existsSync(built) && (statSync(built).mode & 0o111) !== 0o111) {
    chmodSync(built, 0o755);
    fixed.push(built);
  }
  return fixed;
}

/**
 * Makes sure Node itself can load `node-pty`.
 *
 * The package ships prebuilds for macOS and Windows only; on Linux its own
 * `install` script would compile one, and `pnpm-workspace.yaml` deliberately
 * keeps that script off (the shell wants the patched source built for
 * Electron's ABI, not this one). So a Linux checkout has no `pty.node` at all
 * until something builds one, and `vitest` under Node then fails every direct
 * backend test with "Failed to load native module". This compiles the plain
 * Node-ABI build once, into `build/Release`, where node-pty's loader looks
 * first; `--rebuild` overwrites it with the Electron one afterwards.
 */
export function ensureNodeAbiBuild(root = nodePtyDir()) {
  const shipped = join(
    root,
    "prebuilds",
    `${process.platform}-${process.arch}`,
  );
  if (existsSync(join(shipped, "pty.node"))) return "prebuilt";
  if (existsSync(join(root, "build/Release/pty.node"))) return "built";
  // node-gyp is not a dependency of ours; it is `@electron/rebuild`'s, and
  // pnpm keeps it beside that package rather than in our `node_modules`.
  const rebuildDir = dirname(
    require.resolve("@electron/rebuild/package.json", { paths: [app] }),
  );
  const gyp = require.resolve("node-gyp/bin/node-gyp.js", {
    paths: [rebuildDir],
  });
  const result = spawnSync(process.execPath, [gyp, "rebuild"], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.stderr.write(
      "node-gyp could not build node-pty for Node; direct terminals will not open\n",
    );
    process.exit(result.status ?? 1);
  }
  return "compiled";
}

/**
 * Patch and rebuild for this Electron's ABI. Both halves, in this order: the
 * patch must land before anything is compiled, because what ships is the
 * compiled artefact; the rebuild is needed because the prebuild is for Node's
 * ABI and Electron's differs.
 */
export function ensureNodePtyForElectron() {
  const patch = spawnSync(
    process.execPath,
    [join(here, "patch-node-pty.mjs")],
    {
      stdio: "inherit",
    },
  );
  if (patch.status !== 0) {
    process.stderr.write(
      "node-pty could not be patched; refusing to build it\n",
    );
    process.exit(patch.status ?? 1);
  }
  const rebuild = spawnSync(
    "npx",
    // `--arch` is explicit because the default is not this machine's: on an
    // arm64 Mac, `electron-rebuild` without it produced x86_64 binaries that
    // loaded fine (N-API) and then failed every spawn with `posix_spawnp
    // failed.` — nothing in that message points at the architecture.
    [
      "--no-install",
      "electron-rebuild",
      "-f",
      "-w",
      "node-pty",
      "--arch",
      process.arch,
    ],
    { cwd: app, stdio: "inherit" },
  );
  if (rebuild.status !== 0) {
    process.stderr.write(
      "electron-rebuild failed for node-pty; terminals will not open\n",
    );
    process.exit(rebuild.status ?? 1);
  }
  assertNativeArch(join(nodePtyDir(), "build/Release"));
  ensurePrebuiltExecutable();
}

/** Refuses a build for the wrong architecture, loudly and here. */
export function assertNativeArch(releaseDir) {
  const expected = process.arch === "arm64" ? "arm64" : "x86_64";
  for (const name of ["pty.node", "spawn-helper"]) {
    const path = join(releaseDir, name);
    if (!existsSync(path)) {
      process.stderr.write(`node-pty did not produce ${name}\n`);
      process.exit(1);
    }
    const described = spawnSync("file", ["-b", path], {
      encoding: "utf8",
    }).stdout;
    if (!described?.includes(expected)) {
      process.stderr.write(
        `node-pty's ${name} is not ${expected} (${described?.trim()}); ` +
          "every terminal would fail with `posix_spawnp failed.`\n",
      );
      process.exit(1);
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith("ensure-node-pty.mjs")) {
  if (process.argv.includes("--rebuild")) ensureNodePtyForElectron();
  else {
    if (ensureNodeAbiBuild() === "compiled")
      process.stdout.write("node-pty: compiled the Node-ABI build\n");
    const fixed = ensurePrebuiltExecutable();
    if (fixed.length > 0)
      process.stdout.write(
        `node-pty: restored the executable bit on ${fixed.length} helper(s)\n`,
      );
  }
}
