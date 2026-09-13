/**
 * `pnpm --filter @armadra/desktop build`.
 *
 * Two steps, in this order and for this reason: the signing decision is made
 * and reported *before* the sidecars are compiled, so a build that could not be
 * signed says so in the first second rather than in the last one
 * (see `signing.mjs`).
 *
 * Which bundles come out is *not* decided here. Tauri merges
 * `tauri.<platform>.conf.json` into the configuration on its own, and the three
 * of them next to `tauri.conf.json` name the bundle targets for each platform —
 * `app`/`dmg`, `msi`/`nsis`, `appimage`/`deb`/`rpm`. Those files hold no comment
 * explaining that, because `tauri-build` rejects any field it does not know,
 * `$comment` included; the reasoning lives in docs/guides/ci-release.md §2.2,
 * and the short version is that the list has to match `desktopAssets()` in
 * tools/release/artifacts.mjs one for one, which `"targets": "all"` cannot
 * promise across Tauri versions.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { main as prepareSidecar } from "./prepare-sidecar.mjs";
import { REQUIRE_ENV, signingPlan, tauriArgs } from "./signing.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");

/**
 * Run the Tauri CLI through Node rather than through `pnpm exec`.
 *
 * On Windows the package manager is a `.cmd` shim, and `execFileSync` without a
 * shell cannot start one — Node refuses outright since 20.12. Resolving the
 * CLI's own JavaScript entry point sidesteps that, and it also means the build
 * does not depend on which package manager happened to invoke this script.
 */
export function tauriEntry(from = app) {
  return createRequire(join(from, "package.json")).resolve(
    "@tauri-apps/cli/tauri.js",
  );
}

export function build({ env = process.env, argv = [] } = {}) {
  const config = JSON.parse(
    readFileSync(join(app, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const plan = signingPlan({ env, config });
  if (plan.mode === "refuse") {
    console.error(`✗ ${plan.message}`);
    return 1;
  }
  // A skipped signature is a warning, not a footnote: it changes what the
  // resulting build is, and CI turns it into a failure with REQUIRE_ENV.
  (plan.mode === "skip" ? console.warn : console.log)(
    `${plan.mode === "skip" ? "!" : "→"} ${plan.message}`,
  );

  prepareSidecar();
  execFileSync(
    process.execPath,
    [tauriEntry(), "build", ...tauriArgs(plan, env), ...argv],
    {
      cwd: app,
      stdio: "inherit",
      env,
    },
  );
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(build({ argv: process.argv.slice(2) }));
}

export { REQUIRE_ENV };
