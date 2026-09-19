/**
 * `pnpm --filter @armadra/desktop dist`.
 *
 * Three steps, in this order and for this reason (same ordering as the
 * Tauri-era `scripts/build.mjs`): the signing decision is made and reported
 * *before* anything is built, so a build that cannot be signed says so in the
 * first second rather than after a multi-minute `electron-vite build` +
 * packaging run; the renderer/main/preload bundle is built next; the sidecar
 * binaries are staged last, immediately before electron-builder needs them,
 * so a stale `resources/` directory from an earlier target never survives
 * into a new one silently (`stageBinaries` always copies fresh).
 *
 * Local `dist` always injects `extraMetadata.armadraUpdates = "disabled"`
 * (W2.2's read side keys off this field): a local build is indistinguishable
 * from a published one to `app.isPackaged`, so without this marker it would
 * poll a production update feed that never published its version — the same
 * problem nodeterm's `nodeTermUpdates` marker exists to avoid
 * (docs/research/nodeterm/process-model-and-platform.md §4).
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
 * `build.mjs`'s `tauriEntry` — `execFileSync` without a shell cannot start a
 * `.cmd` wrapper on Windows, and resolving the package's own entry point
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
export function resolveConfig({ env = process.env, local = true } = {}) {
  const base = load(readFileSync(join(app, "electron-builder.yml"), "utf8"));
  const plan = signingPlan({ env });
  let config = mergeConfig(base, configOverride(plan, env));
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

  execFileSync(process.execPath, [electronViteEntry(), "build"], {
    cwd: app,
    stdio: "inherit",
    env,
  });

  const target = selectTarget({ host: rustHost(), env, native: true });
  for (const path of stageBinaries({ env, target }))
    console.log(`Staged binary: ${path}`);

  // Imported lazily: electron-builder pulls in a large dependency tree, and
  // every other script in this file (and its tests) should be importable
  // without paying for that.
  const {
    Platform,
    build: packageApp,
    createTargets,
  } = await import("electron-builder");
  const artifacts = await packageApp({
    // No explicit target type: electron-builder falls back to the platform's
    // `target` list in electron-builder.yml, which is the one whose
    // correspondence with tools/release/artifacts.mjs is tested. Host arch
    // only — a local build packages what it can run.
    targets: createTargets([Platform.current()], null, process.arch),
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
