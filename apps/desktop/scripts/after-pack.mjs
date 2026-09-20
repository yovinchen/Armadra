/**
 * electron-builder `afterPack` hook: puts the `out/` bundles and the migration
 * files into the unpacked app's resources directory ourselves, with a retry.
 *
 * They used to travel as `extraResources`. On the Windows CI runners
 * electron-builder's own copy of them failed with `EBUSY: resource busy or
 * locked` — a different file each run, still after the real-time scanner was
 * switched off, and while a rename probe a moment earlier found nothing
 * holding the file. Whatever holds it does so briefly, and electron-builder
 * copies once and gives up. This copies the same files to the same places, but
 * tries again for a bounded while before it gives up; when it does give up it
 * names the processes that have the file mapped, so the failure says its
 * cause. Nothing of ours is left to `extraResources`, so the one-shot copy has
 * nothing left to trip on.
 *
 * `afterPack` runs before signing on every platform (app-builder-lib's
 * `doPack` emits it, then `doSignAfterPack`), so a file placed here is signed
 * and notarized with the bundle exactly as an `extraResources` entry would
 * have been.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(dirname(fileURLToPath(import.meta.url)));

/** How long one file may keep refusing to copy before the hook fails. */
export const COPY_LIMIT_MS = 120_000;

/** electron-builder's `Arch` numbering → the name `process.arch` uses. */
const ARCH_NAMES = ["ia32", "x64", "armv7l", "arm64", "universal"];

/** The platform/arch pairs this shell is packaged for. */
const SUPPORTED = {
  darwin: ["arm64", "x64"],
  win32: ["arm64", "x64"],
  linux: ["arm64", "x64"],
};

/** Refuse a platform/arch pair nothing ships, before anything is copied. */
export function platformFor(platformName, archName) {
  if (!SUPPORTED[platformName]?.includes(archName)) {
    throw new Error(
      `after-pack: no bundle target for ${platformName}/${archName}`,
    );
  }
  return platformName;
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

/**
 * The electron-vite bundles a given platform ships, at the paths the launchers
 * name.
 *
 * They are produced by `pnpm --filter @armadra/desktop build` into `out/` and
 * copied from there verbatim, outside the asar: the hook client is named with
 * an absolute path by a generated launcher, and the session host is started as
 * `ELECTRON_RUN_AS_NODE=1 <Electron> <resources>/session-host/host.cjs`, which
 * has to be a real file on disk.
 *
 * `out/session-host/host.cjs` is Windows-only: ConPTY sessions have to outlive
 * the shell there, and tmux already does that job on macOS and Linux (R6d).
 */
export function bundleResources(platformName) {
  const resources = [
    { from: "out/cli/armadra-hook.js", to: "cli/armadra-hook.js" },
    // The app icon the tray cuts its menu-bar glyph from. `main/tray.ts`
    // reads it from the checkout in development and from
    // `process.resourcesPath` in a packaged app; without this entry the
    // packaged tray logged "could not be loaded" and stayed off.
    { from: "build/icons/icon.png", to: "tray.png" },
  ];
  if (platformName === "win32")
    resources.push({
      from: "out/session-host/host.cjs",
      to: "session-host/host.cjs",
    });
  return resources;
}

/** Where the `.sql` files are in the checkout, and where they go in a bundle. */
export const MIGRATIONS_FROM = "src/core/db/migrations";
export const MIGRATIONS_TO = "migrations";

/**
 * The migration files, as `{from, to}` pairs.
 *
 * A packaged core has no checkout to walk up into, so `core/db/migrations.ts`'s
 * `resolveMigrationsDir` looks for exactly `<resources>/migrations`. They are
 * copied file by file rather than as a directory so that every placement goes
 * through the same retry as everything else here.
 */
export function migrationResources(from = join(app, MIGRATIONS_FROM)) {
  return readdirSync(from)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      from: `${MIGRATIONS_FROM}/${name}`,
      to: `${MIGRATIONS_TO}/${name}`,
    }));
}

/**
 * Everything this hook places for a platform: the `out/` bundles, then the
 * migrations the core reads at start-up.
 *
 * There are no sidecar binaries any more. The core is one of those `out/`
 * bundles and runs on the Electron the app already ships, so nothing here is
 * marked executable.
 */
export function placements(platformName) {
  return [...bundleResources(platformName), ...migrationResources()].map(
    (resource) => ({ ...resource, executable: false }),
  );
}

export default async function afterPack(context) {
  const platformName = context.electronPlatformName;
  const archName = ARCH_NAMES[context.arch] ?? process.arch;
  platformFor(platformName, archName);
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  for (const placement of placements(platformName)) {
    const source = join(app, placement.from);
    if (!existsSync(source)) {
      throw new Error(
        `after-pack: ${source} is missing; the electron-vite build runs before packaging`,
      );
    }
    const destination = join(resourcesDir, placement.to);
    mkdirSync(dirname(destination), { recursive: true });
    copyWithRetry(source, destination);
    if (placement.executable && platformName !== "win32")
      chmodSync(destination, 0o755);
    console.log(`after-pack: placed ${placement.to}`);
  }
}
