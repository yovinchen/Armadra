import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The two seams this scan holds open.
 *
 * `src/shell-core/` holds the shell's pure logic — data directory resolution,
 * Runtime identity, Host answer validation, the update state machine — and may
 * not reach for Electron or for the main process. The rule exists because the
 * process-specific file is only plumbing, and anything with a rule worth
 * stating should be testable without starting a window.
 *
 * `src/core/` is the stricter one, and the reason it is here rather than in a
 * second copy of this file: the core must run as plain Node under a windowless
 * server shell, so an `import "electron"` there is not untidy — it is the
 * difference between a core that runs in two shells and one that runs in one.
 * The core may not import Electron, may not reach into `../main/`, and may not
 * reach into `../shell-core/` either: the shell's own logic is the shell's, and
 * a core that borrowed it would drag the shell's assumptions along.
 *
 * A boundary nobody checks drifts within a release, so this scan is the check,
 * and the second and third `it` prove the regexes against samples that must be
 * caught and samples that must be let through.
 */

const here = dirname(fileURLToPath(import.meta.url));
const coreRoot = resolve(here, "../core");

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

// The core's rule is the same plus `../shell-core/`.
const CORE_OFFENDERS =
  /from ['"]electron(\/[^'"]*)?['"]|require\(['"]electron(\/[^'"]*)?['"]\)|from ['"](\.\.\/)+(main|shell-core)\//;

describe("shell-core boundary", () => {
  it("no file under src/shell-core imports electron or reaches back into ../main", () => {
    const offenders = walk(here)
      // This file carries sample offender strings below to prove the regexes,
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

describe("core boundary", () => {
  it("the core is a real directory with source in it", () => {
    // A scan over an empty or renamed directory passes for the wrong reason.
    expect(walk(coreRoot).length).toBeGreaterThan(10);
  });

  it("no file under src/core imports electron, ../main or ../shell-core", () => {
    const offenders = walk(coreRoot).filter((file) =>
      CORE_OFFENDERS.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("the core regex flags electron and both reach-backs", () => {
    for (const bad of [
      `import { app } from 'electron'`,
      `import { safeStorage } from "electron/main"`,
      `const { utilityProcess } = require('electron')`,
      `import { RuntimeProcess } from '../main/runtime-process'`,
      `import { dataDir } from '../shell-core/paths'`,
      `import { parseHealth } from '../../shell-core/runtime/identity'`,
    ]) {
      expect(CORE_OFFENDERS.test(bad), bad).toBe(true);
    }
  });

  it("the core regex leaves the imports a core may write alone", () => {
    for (const ok of [
      `import { DatabaseSync } from 'node:sqlite'`,
      `import { WebSocketServer } from 'ws'`,
      `import { dataDir } from './paths'`,
      `import { preflight } from './db/ledger'`,
      // Not Electron, and the substring must not fool us.
      `import electronBuilder from 'electron-builder'`,
    ]) {
      expect(CORE_OFFENDERS.test(ok), ok).toBe(false);
    }
  });
});
