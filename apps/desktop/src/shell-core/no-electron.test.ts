import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The seam. `src/shell-core/` holds the shell's pure logic — data directory
 * resolution, Runtime identity, Host answer validation, the update state
 * machine later — and may not reach for Electron or for the main process.
 *
 * The rule exists for the same reason the Rust shell gave: the
 * process-specific file is only plumbing, and anything with a rule worth
 * stating should be testable without starting a window. A boundary nobody
 * checks drifts within a release, so this scan is the check.
 */

const here = dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

// Catches, via either `import` or `require`: bare `electron`, electron
// subpaths (`electron/main`), and any reach-back into the shell's main process
// (`../main/`, `../../main/`).
const OFFENDERS =
  /from ['"]electron(\/[^'"]*)?['"]|require\(['"]electron(\/[^'"]*)?['"]\)|from ['"](\.\.\/)+main\//;

describe("shell-core boundary", () => {
  it("no file under src/shell-core imports electron or reaches back into ../main", () => {
    const offenders = walk(here)
      // This file carries sample offender strings below to prove the regex,
      // so it is the one file the scan must skip.
      .filter((file) => file !== fileURLToPath(import.meta.url))
      .filter((file) => OFFENDERS.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the regex flags electron, electron subpaths and ../main reach-backs", () => {
    for (const bad of [
      `import { app } from 'electron'`,
      `import { BrowserWindow } from "electron"`,
      `const { ipcMain } = require('electron')`,
      `import { x } from 'electron/main'`,
      `import { RuntimeProcess } from '../main/runtime-process'`,
      `import { lifecycle } from '../../main/lifecycle'`,
    ]) {
      expect(OFFENDERS.test(bad), bad).toBe(true);
    }
  });

  it("the regex leaves legitimate shell-core imports alone", () => {
    for (const ok of [
      `import { readFileSync } from 'node:fs'`,
      `import { dataDir } from './paths'`,
      `import { IPC } from '../shared/ipc'`,
      `import { fromBinary } from '@armadra/protocol'`,
      // The package is not Electron itself, and the substring must not fool us.
      `import electronBuilder from 'electron-builder'`,
    ]) {
      expect(OFFENDERS.test(ok), ok).toBe(false);
    }
  });
});
