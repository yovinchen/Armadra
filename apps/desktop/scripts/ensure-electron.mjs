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

if (existsSync(pathFile) && existsSync(dist)) process.exit(0);

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
