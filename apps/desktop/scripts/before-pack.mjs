/**
 * electron-builder `beforePack` hook: on Windows, refuse to let the packager
 * start copying the staged sidecar binaries until nothing else holds them.
 *
 * The symptom this answers is `EBUSY: resource busy or locked, copyfile
 * resources/<binary>.exe -> release/win-unpacked/resources/<binary>.exe` in
 * the packaging step, on the runner only, on a different binary each time.
 * Excluding the directories from the real-time scanner and then switching the
 * scanner off did not change it, so the holder is something else. This hook
 * does two things: it waits (bounded) until each binary can be renamed —
 * a rename fails with the same sharing violation a copy does, so it is the
 * honest probe — and, while it waits, it prints which processes have the file
 * mapped, so the next failure names its cause instead of only its symptom.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

/** How long a binary may stay held before the hook gives up, in ms. */
export const HOLD_LIMIT_MS = 90_000;

/**
 * Tries to rename `file` to a probe name and back. `true` when both renames
 * succeeded — nothing else has the file open in a way a copy would trip on.
 */
export function unshared(file) {
  const probe = `${file}.probe`;
  try {
    renameSync(file, probe);
  } catch (error) {
    if (error?.code === "EBUSY" || error?.code === "EPERM") return false;
    throw error;
  }
  renameSync(probe, file);
  return true;
}

/** The processes with `file` loaded as an image or a module, one per line. */
export function holders(file) {
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

export function waitUntilUnshared(
  file,
  {
    limitMs = HOLD_LIMIT_MS,
    stepMs = 1_000,
    log = console.log,
    probe = unshared,
    report = holders,
  } = {},
) {
  const started = Date.now();
  let reported = false;
  while (!probe(file)) {
    if (!reported) {
      log(
        `before-pack: ${file} is held by another process; holders:\n${report(file) || "  (none with it mapped — a handle without a mapping)"}`,
      );
      reported = true;
    }
    if (Date.now() - started > limitMs) {
      throw new Error(
        `before-pack: ${file} stayed locked for ${limitMs / 1000}s`,
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stepMs);
  }
  if (reported)
    log(`before-pack: ${file} released after ${Date.now() - started} ms`);
}

export default async function beforePack(context) {
  if (process.platform !== "win32") return;
  const resources = join(context.packager.projectDir, "resources");
  for (const name of readdirSync(resources)) {
    if (!name.endsWith(".exe")) continue;
    waitUntilUnshared(join(resources, name));
  }
}
