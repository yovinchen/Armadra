/**
 * electron-builder `afterPack` hook: puts the staged sidecar binaries into the
 * unpacked app's resources directory ourselves, with a retry.
 *
 * They used to travel as `extraResources`. On the Windows CI runners
 * electron-builder's own copy of them failed with `EBUSY: resource busy or
 * locked` — a different binary each run, still after the real-time scanner
 * was switched off, and while a rename probe a moment earlier found nothing
 * holding the file. Whatever holds it does so briefly, and electron-builder
 * copies once and gives up. This copies the same files to the same place,
 * but tries again for a bounded while before it gives up; when it does give
 * up it names the processes that have the file mapped, so the failure says
 * its cause.
 *
 * `afterPack` runs before signing on every platform (app-builder-lib's
 * `doPack` emits it, then `doSignAfterPack`), so a binary placed here is
 * signed and notarized with the bundle exactly as an `extraResources` entry
 * would have been.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { goTarget } from "./sidecar-targets.mjs";
import { binariesFor } from "./stage-binaries.mjs";

const app = dirname(dirname(fileURLToPath(import.meta.url)));

/** How long one binary may keep refusing to copy before the hook fails. */
export const COPY_LIMIT_MS = 120_000;

/** electron-builder's `Arch` numbering → the name `process.arch` uses. */
const ARCH_NAMES = ["ia32", "x64", "armv7l", "arm64", "universal"];

/** The Rust target triple a packaged platform/arch pair corresponds to. */
export function tripleFor(platformName, archName) {
  const table = {
    "darwin/arm64": "aarch64-apple-darwin",
    "darwin/x64": "x86_64-apple-darwin",
    "win32/arm64": "aarch64-pc-windows-msvc",
    "win32/x64": "x86_64-pc-windows-msvc",
    "linux/arm64": "aarch64-unknown-linux-gnu",
    "linux/x64": "x86_64-unknown-linux-gnu",
  };
  const triple = table[`${platformName}/${archName}`];
  if (!triple) {
    throw new Error(
      `after-pack: no sidecar target for ${platformName}/${archName}`,
    );
  }
  return triple;
}

/** The processes with `file` loaded as an image or a module (Windows only). */
export function holders(file) {
  if (process.platform !== "win32") return "";
  const escaped = file.replace(/'/g, "''");
  const script = [
    `$target = '${escaped}'`,
    "Get-Process | ForEach-Object {",
    "  $p = $_",
    "  try {",
    '    if ($p.Path -eq $target) { "$($p.Id) $($p.ProcessName) (image)" }',
    '    elseif ($p.Modules | Where-Object { $_.FileName -eq $target }) { "$($p.Id) $($p.ProcessName) (module)" }',
    "  } catch {}",
    "}",
  ].join("\n");
  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
  });
  return (result.stdout ?? "").trim();
}

/**
 * Copies `source` to `destination`, retrying a sharing violation (`EBUSY` /
 * `EPERM`) until `limitMs` has passed. Any other error is thrown at once.
 */
export function copyWithRetry(
  source,
  destination,
  {
    limitMs = COPY_LIMIT_MS,
    stepMs = 1_000,
    copy = copyFileSync,
    log = console.log,
    report = holders,
    now = Date.now,
    sleep = (ms) =>
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  } = {},
) {
  const started = now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      copy(source, destination);
      if (attempts > 1)
        log(`after-pack: ${source} copied after ${attempts} attempts`);
      return attempts;
    } catch (error) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
      if (attempts === 1) {
        const who = report(source) || report(destination);
        log(
          `after-pack: ${source} is busy (${error.code}); holders:\n${who || "  (none with it mapped)"}`,
        );
      }
      if (now() - started > limitMs) {
        throw new Error(
          `after-pack: ${source} stayed busy for ${limitMs / 1000}s (${error.code})`,
        );
      }
      sleep(stepMs);
    }
  }
}

export default async function afterPack(context) {
  const platformName = context.electronPlatformName;
  const archName = ARCH_NAMES[context.arch] ?? process.arch;
  const triple = tripleFor(platformName, archName);
  const { extension } = goTarget(triple);
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  mkdirSync(resourcesDir, { recursive: true });
  for (const binary of binariesFor(triple)) {
    const name = `${binary}${extension}`;
    const source = join(app, "resources", name);
    if (!existsSync(source)) {
      throw new Error(
        `after-pack: ${source} is not staged; scripts/stage-binaries.mjs runs before packaging`,
      );
    }
    const destination = join(resourcesDir, name);
    copyWithRetry(source, destination);
    if (platformName !== "win32") chmodSync(destination, 0o755);
    console.log(`after-pack: placed ${name}`);
  }
}
