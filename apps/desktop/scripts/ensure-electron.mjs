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
ensureNodePty();
process.exit(0);

/**
 * Patch and rebuild `node-pty` for this Electron's ABI.
 *
 * Both halves are required and in this order. The patch closes the pty-device
 * leaks documented in `patch-node-pty.mjs` and must land before anything is
 * compiled, because what ships is the compiled artefact. The rebuild is
 * needed because pnpm installs the module's prebuild for *Node's* ABI, and
 * Electron's is different: loading the wrong one throws
 * NODE_MODULE_VERSION at require time, which in a packaged app means every
 * terminal fails to open with a message about a module version.
 *
 * Idempotent, and cheap when there is nothing to do: the patch stops at its
 * own marker, and `electron-rebuild` skips a module already built for the
 * target ABI.
 */
function ensureNodePty() {
  const here = dirname(new URL(import.meta.url).pathname);
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
  const app = join(here, "..");
  const rebuild = spawnSync(
    "npx",
    [
      "--no-install",
      "electron-rebuild",
      "-f",
      "-w",
      "node-pty",
      // Explicit, because the default is not this machine's. Observed on an
      // arm64 Mac: `electron-rebuild` without `--arch` produced an x86_64
      // `pty.node` AND an x86_64 `spawn-helper`. The addon still loaded — it
      // is N-API, so the ABI matched — and every spawn then failed with
      // `posix_spawnp failed.`, because that is what exec'ing a Mach-O of the
      // wrong architecture looks like from inside node-pty. Nothing in that
      // message points at the architecture.
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
  assertNativeArch(join(app, "node_modules/node-pty/build/Release"));
}

/**
 * Refuses a build for the wrong architecture, loudly and here.
 *
 * The failure it catches is silent everywhere else: the addon loads, the
 * module resolves, and the only symptom is `posix_spawnp failed.` from the
 * first terminal anybody opens. `file(1)` answers in one line what took an
 * afternoon to find the first time.
 */
function assertNativeArch(releaseDir) {
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
