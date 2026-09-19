/**
 * `pnpm --filter @armadra/desktop dist`.
 *
 * Three steps, in this order and for this reason: the signing decision is
 * made and reported
 * *before* anything is built, so a build that cannot be signed says so in the
 * first second rather than after a multi-minute `electron-vite build` +
 * packaging run; the renderer/main/preload bundle is built next; the sidecar
 * binaries are staged first (see the note in `main` about Windows file locks),
 * so a stale `resources/` directory from an earlier target never survives
 * into a new one silently (`stageBinaries` always copies fresh).
 *
 * Local `dist` always injects `extraMetadata.armadraUpdates = "disabled"`
 * (W2.2's read side keys off this field): a local build is indistinguishable
 * from a published one to `app.isPackaged`, so without this marker it would
 * poll a production update feed that never published its version.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

import { rustHost } from "./prepare-host.mjs";
import { selectTarget } from "./sidecar-targets.mjs";
import { stageBinaries } from "./stage-binaries.mjs";
import {
  REQUIRE_ENV,
  configOverride,
  signingPlan,
} from "./signing-electron.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");

/**
 * Resolve electron-vite's CLI as JavaScript rather than shelling out to
 * `pnpm run build` or `npx electron-vite`: the same reasoning as
 * `execFileSync` without a shell cannot start a `.cmd` wrapper on Windows,
 * and resolving the package's own entry point
 * means this does not depend on which package manager invoked it.
 */
export function electronViteEntry(from = app) {
  // electron-vite's package.json does not export "./bin/electron-vite.js" (only
  // ".", "./node" and "./package.json"), so the bin script has to be located
  // relative to the resolved package root rather than required directly.
  const packageJson = createRequire(join(from, "package.json")).resolve(
    "electron-vite/package.json",
  );
  return join(dirname(packageJson), "bin", "electron-vite.js");
}

/** A plain-object recursive merge; arrays and non-object values are replaced, never concatenated. */
export function mergeConfig(base, override) {
  if (override === null || override === undefined) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = base[key];
    result[key] =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing)
        ? mergeConfig(existing, value)
        : value;
  }
  return result;
}

/** The electron-builder configuration this run packages with: the checked-in file, the signing plan's override, and — for a local build — the disabled-updates marker. */
/**
 * The architecture this run packages for: the host's, unless
 * `ARMADRA_DIST_ARCH` says otherwise.
 *
 * `electron-builder.yml` lists both architectures under every target so the
 * file documents what a release ships, but a single run must build one: the
 * `arch` argument to `createTargets` does not override a per-target list, and
 * the second architecture then rebuilds node-pty as a cross-compile (`-m64`
 * on an arm64 runner, the x64 MSBuild on Windows-on-ARM) and fails. Each CI
 * matrix row is one architecture, so each packages exactly its own.
 */
export function distArch(env = process.env) {
  const wanted = env.ARMADRA_DIST_ARCH ?? process.arch;
  if (wanted !== "x64" && wanted !== "arm64") {
    throw new Error(`ARMADRA_DIST_ARCH must be x64 or arm64, not ${wanted}`);
  }
  return wanted;
}

/** `mac` / `win` / `linux` — the config section a platform packages from. */
export function platformKey(platform) {
  switch (platform.name) {
    case "mac":
      return "mac";
    case "windows":
      return "win";
    default:
      return "linux";
  }
}

/** The target types a config section lists, in its order. */
export function targetNames(config, key) {
  const section = config[key];
  if (!section || !Array.isArray(section.target)) return [];
  return section.target.map((entry) =>
    typeof entry === "string" ? entry : entry.target,
  );
}

function restrictArch(config, arch) {
  const result = { ...config };
  for (const platform of ["mac", "win", "linux"]) {
    const section = config[platform];
    if (!section || !Array.isArray(section.target)) continue;
    result[platform] = {
      ...section,
      target: section.target.map((entry) =>
        typeof entry === "string"
          ? { target: entry, arch: [arch] }
          : { ...entry, arch: [arch] },
      ),
    };
  }
  return result;
}

export function resolveConfig({ env = process.env, local = true } = {}) {
  const base = load(readFileSync(join(app, "electron-builder.yml"), "utf8"));
  const plan = signingPlan({ env });
  let config = restrictArch(
    mergeConfig(base, configOverride(plan, env)),
    distArch(env),
  );
  if (local) {
    config = mergeConfig(config, {
      extraMetadata: { armadraUpdates: "disabled" },
    });
  }
  return { config, plan };
}

export async function dist({ env = process.env, local = true } = {}) {
  const { config, plan } = resolveConfig({ env, local });
  if (plan.mode === "refuse") {
    console.error(`✗ ${plan.message}`);
    return 1;
  }
  (plan.mode === "skip" ? console.warn : console.log)(
    `${plan.mode === "skip" ? "!" : "→"} ${plan.message}`,
  );

  // Staged BEFORE the renderer/main build on purpose: on Windows a freshly
  // copied executable stays locked by the real-time scanner for a while, and
  // electron-builder's own copy of it fails with EBUSY. The build takes long
  // enough that the lock is gone by the time the packager runs;
  // `stageBinaries` also waits until each file opens again before returning.
  const target = selectTarget({ host: rustHost(), env, native: true });
  for (const path of stageBinaries({ env, target }))
    console.log(`Staged binary: ${path}`);

  execFileSync(process.execPath, [electronViteEntry(), "build"], {
    cwd: app,
    stdio: "inherit",
    env,
  });

  // Imported lazily: electron-builder pulls in a large dependency tree, and
  // every other script in this file (and its tests) should be importable
  // without paying for that.
  const {
    Arch,
    Platform,
    build: packageApp,
  } = await import("electron-builder");
  const platform = Platform.current();
  const arch = distArch(env);
  const artifacts = await packageApp({
    // The target *types* come from electron-builder.yml (the list whose
    // correspondence with tools/release/artifacts.mjs is tested); the
    // architecture is this run's alone. Named explicitly rather than left to
    // the config: a target map with no type names makes electron-builder walk
    // the config's own `arch` lists again, and on CI that walk still produced
    // an x64 build on an arm64 runner (see `distArch`).
    targets: platform.createTarget(
      targetNames(config, platformKey(platform)),
      Arch[arch],
    ),
    config,
  });
  for (const artifact of artifacts) console.log(`Built: ${artifact}`);
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  dist()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { REQUIRE_ENV };
