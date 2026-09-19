#!/usr/bin/env node
/**
 * Make sure the Electron binary is actually on disk before `electron-vite dev`
 * or `dist` tries to launch it.
 *
 * pnpm only runs electron's postinstall (the download) for a package it
 * installs AFTER `allowBuilds.electron` was granted; a workspace that already
 * had the package cached keeps a `node_modules/electron` with no `dist/` and
 * no `path.txt`, and electron-vite then fails with the unhelpful
 * "Error: Electron uninstall". Three separate checkouts hit this in one day,
 * so the check lives here rather than in a README.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const packageDir = dirname(require.resolve("electron/package.json"));
const pathFile = join(packageDir, "path.txt");
const dist = join(packageDir, "dist");

if (!(existsSync(pathFile) && existsSync(dist))) install();
brandDevBundle();
process.exit(0);

function install() {
  process.stdout.write(
    "Electron binary missing; running electron's install.js\n",
  );
  const result = spawnSync(process.execPath, [join(packageDir, "install.js")], {
    cwd: packageDir,
    stdio: "inherit",
  });
  if (result.status !== 0 || !existsSync(pathFile)) {
    process.stderr.write(
      "Electron did not install; check network access or ELECTRON_MIRROR\n",
    );
    process.exit(result.status ?? 1);
  }
}

/**
 * Brand the development bundle.
 *
 * `app.setName()` only renames what Electron itself reports (About panel,
 * `app.name`); macOS reads the Dock label and the menu-bar title from the
 * bundle's `Info.plist`, and the Dock icon from `electron.icns`, so a dev run
 * shows "Electron" no matter what the main process says. The packaged app is
 * built by electron-builder with the right plist and icon; this patches the
 * dev bundle the same way, idempotently. The bundle identifier is left alone
 * so existing permission grants keep matching.
 */
function brandDevBundle() {
  if (process.platform !== "darwin") return;
  const appDir = join(dist, "Electron.app");
  const plist = join(appDir, "Contents", "Info.plist");
  const icns = join(appDir, "Contents", "Resources", "electron.icns");
  const brandIcon = join(
    dirname(new URL(import.meta.url).pathname),
    "..",
    "build",
    "icons",
    "icon.icns",
  );
  if (!existsSync(plist)) return;
  const buddy = "/usr/libexec/PlistBuddy";
  const read = (key) =>
    spawnSync(buddy, ["-c", `Print :${key}`, plist], {
      encoding: "utf8",
    }).stdout.trim();
  if (read("CFBundleName") !== "Armadra") {
    for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
      spawnSync(buddy, ["-c", `Set :${key} Armadra`, plist], {
        stdio: "ignore",
      });
    }
    process.stdout.write(
      "Branded the development Electron bundle as Armadra\n",
    );
  }
  if (existsSync(brandIcon) && existsSync(icns)) {
    const { readFileSync, writeFileSync } = require("node:fs");
    const wanted = readFileSync(brandIcon);
    if (!readFileSync(icns).equals(wanted)) {
      writeFileSync(icns, wanted);
      // Launch Services caches icons per bundle path; touching the bundle
      // invalidates that cache so the Dock picks the new one up.
      spawnSync("touch", [appDir]);
    }
  }
}
