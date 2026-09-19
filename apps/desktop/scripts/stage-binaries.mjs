/**
 * Stage the four sidecar binaries into `apps/desktop/resources/` before
 * electron-builder runs.
 *
 *   node apps/desktop/scripts/stage-binaries.mjs [--target <triple>] [--placeholders]
 *
 * One script rather than the several the previous shell needed: nothing here
 * has to rename a binary to `<name>-<triple>`, because `extraResources` copies
 * files verbatim into `process.resourcesPath`, which `runtime-process.ts`'s
 * `runtimeExecutable()` already resolves against (armadra-inventory.md §2
 * item 29).
 *
 * This script never builds anything. Building
 * the Runtime, the hook client and the Go Host takes minutes, which is the
 * wrong cost to pay every time packaging is invoked (and the wrong tool to
 * hold a `cargo build`/`go build` invocation this script does not own); it
 * copies what is already at `target/release` and fails loudly, with the exact
 * missing path, when a binary is not there — never a placeholder, because a
 * placeholder here would package a shell that starts and then cannot find its
 * own Runtime. Placeholders exist only for `--placeholders`, which CI's
 * `electron-vite build` smoke job uses to satisfy a check that never runs the
 * binary.
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { repository, rustHost } from "./prepare-host.mjs";
import {
  goTarget,
  rustSidecars,
  selectTarget,
  sidecarPaths,
} from "./sidecar-targets.mjs";

export const RESOURCES_DIR = "apps/desktop/resources";

/** Every binary the packaged shell needs beside it: the Rust sidecars a given target ships, plus the Go Host. */
export function binariesFor(triple) {
  return [
    ...rustSidecars(triple).map((sidecar) => sidecar.binary),
    "armadra-host",
  ];
}

/** Where a staged binary lands: `apps/desktop/resources/<binary>[.exe]`, no triple suffix. */
export function resourceDestination({ root = repository, binary, target }) {
  const { extension } = goTarget(target.triple);
  return resolve(root, RESOURCES_DIR, `${binary}${extension}`);
}

/**
 * Copies (or, with `placeholders: true`, touches empty) every binary the
 * given target needs into `apps/desktop/resources/`.
 *
 * Throws one error naming every missing binary and where it was expected,
 * rather than failing on the first — packaging locally after a partial build
 * should say what is still missing in one pass, not one `cargo build` at a
 * time.
 */
export function stageBinaries({
  root = repository,
  env = process.env,
  host = rustHost(),
  target,
  placeholders = false,
} = {}) {
  const selected = target ?? selectTarget({ host, env });
  const staged = [];
  const missing = [];
  for (const binary of binariesFor(selected.triple)) {
    const destination = resourceDestination({ root, binary, target: selected });
    mkdirSync(dirname(destination), { recursive: true });
    if (placeholders) {
      // A real binary from an earlier build is worth more than an empty file.
      if (!existsSync(destination)) writeFileSync(destination, "");
      staged.push(destination);
      continue;
    }
    const { source } = sidecarPaths({
      repository: root,
      env,
      target: selected,
      binary,
    });
    if (!existsSync(source)) {
      missing.push({ binary, source });
      continue;
    }
    copyFileSync(source, destination);
    waitUntilReadable(destination);
    staged.push(destination);
  }
  if (missing.length > 0) {
    const list = missing
      .map((entry) => `  - ${entry.binary}: expected at ${entry.source}`)
      .join("\n");
    throw new Error(
      `stage-binaries: ${missing.length} binaries were not built for ${selected.triple}:\n${list}\n` +
        "Build them first (docs/guides/development.md 打包): " +
        "`cargo build --release -p armadra-runtime -p armadra-hook` and " +
        "`go -C apps/host build ./cmd/armadra-host`, or pass --placeholders for a " +
        "type-check-only invocation that never packages the result.",
    );
  }
  return staged;
}

function parseArguments(args) {
  const options = { placeholders: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--placeholders") options.placeholders = true;
    else if (
      argument === "--target" &&
      args[index + 1] &&
      !args[index + 1].startsWith("--")
    )
      options.target = args[++index];
    else
      throw new Error(
        `Unknown or incomplete stage-binaries argument: ${argument}`,
      );
  }
  return options;
}

export function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const target = selectTarget({
    host: rustHost(),
    env: process.env,
    ...options,
  });
  const staged = stageBinaries({ target, placeholders: options.placeholders });
  for (const path of staged)
    console.log(
      `${options.placeholders ? "Staged empty placeholder" : "Staged binary"}: ${path}`,
    );
  if (options.placeholders) {
    console.warn(
      "These placeholders are empty: use stage-binaries.mjs without --placeholders before packaging.",
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}

/**
 * On Windows a freshly written executable is briefly held by the real-time
 * scanner, and electron-builder's own copy of it into the unpacked app then
 * fails with EBUSY. Waiting until the file can be opened for writing again
 * (bounded, ~15 s) is what makes the packaging step deterministic on CI;
 * elsewhere the first attempt succeeds and this returns at once.
 */
export function waitUntilReadable(file, { attempts = 60, delayMs = 250 } = {}) {
  if (process.platform !== "win32") return;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      closeSync(openSync(file, "r+"));
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  throw new Error(
    `stage-binaries: ${file} stayed locked for ${(attempts * delayMs) / 1000}s`,
  );
}
