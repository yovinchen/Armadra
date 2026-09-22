import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

/**
 * Where the core keeps everything that is not in the database.
 *
 * Resolved exactly the way the pre-merge implementation resolves it, because the
 * two implementations have to name the same directory: a machine that ran the
 * Rust Runtime yesterday and the TypeScript core today must find the same
 * `canvas.db`, the same `endpoints.json` and the same hook endpoint file.
 * `ARMADRA_DATA_DIR` wins on every platform, then the per-platform branch, and
 * each branch falls through when its own variable is absent — the same shape
 * the Rust `cfg!` chain has.
 *
 * `platform` and `env` are parameters rather than reads of `process` so the
 * resolution for all three platforms can be tested on any one of them.
 */
export type PlatformName = "darwin" | "win32" | (string & {});

export interface PathEnvironment {
  readonly ARMADRA_DATA_DIR?: string | undefined;
  readonly LOCALAPPDATA?: string | undefined;
  readonly XDG_DATA_HOME?: string | undefined;
  readonly HOME?: string | undefined;
  readonly [name: string]: string | undefined;
}

export function dataDir(
  platform: PlatformName = process.platform,
  env: PathEnvironment = process.env,
): string {
  // The separator belongs to the platform being *asked about*, not to the one
  // running: this function answers for all three so the resolution can be
  // tested anywhere, and `node:path`'s own `join` would answer every question
  // with backslashes on a Windows machine.
  const { join: on } = platform === "win32" ? win32 : posix;
  if (env.ARMADRA_DATA_DIR) return env.ARMADRA_DATA_DIR;
  if (platform === "darwin" && env.HOME) {
    return on(env.HOME, "Library/Application Support/Armadra");
  }
  if (platform === "win32" && env.LOCALAPPDATA) {
    return on(env.LOCALAPPDATA, "Armadra");
  }
  const base =
    env.XDG_DATA_HOME ?? (env.HOME ? on(env.HOME, ".local/share") : undefined);
  // The last resort is this machine's own temporary directory, so it is the
  // running platform that spells it — not the one being asked about.
  return base === undefined ? join(tmpdir(), "armadra") : on(base, "armadra");
}

/**
 * The data directory this run uses: an explicit `--data-dir` first, then the
 * platform resolution. The flag exists because a second instance, a test and
 * the shell all need to point one core at one directory without touching the
 * environment of everything else in the process tree.
 */
export function resolveDataDir(
  explicit: string | undefined,
  platform: PlatformName = process.platform,
  env: PathEnvironment = process.env,
): string {
  return explicit ?? dataDir(platform, env);
}

/** The shared discovery document every service describes itself in. */
export function endpointsFile(directory: string): string {
  return join(directory, "endpoints.json");
}

/**
 * 0600 file the hook client re-reads on every invocation to find the core.
 * Contractual: it is injected into every agent PTY as `ARMADRA_ENDPOINT_FILE`.
 */
export function hookEndpointFile(directory: string): string {
  return join(directory, "hook-endpoint.env");
}

/** `<data>/node-tokens/<nodeId>`; per-node tokens never travel in the environment. */
export function nodeTokenDir(directory: string): string {
  return join(directory, "node-tokens");
}

/** Pending permission requests and their answer files. */
export function pendingDir(directory: string): string {
  return join(directory, "pending");
}

export function settingsFile(directory: string): string {
  return join(directory, "settings.json");
}

/** The preferences that belong to this machine rather than to the account. */
export function workerSettingsFile(directory: string): string {
  return join(directory, "worker-settings.json");
}

/** The one database. The Rust Runtime opens the same file. */
export function databaseFile(directory: string): string {
  return join(directory, "canvas.db");
}

/**
 * 0700 on unix. Everything in the data directory is a full grant of the core's
 * API — the hook token, the socket, the node tokens — so the directory must not
 * be group- or world-reachable.
 */
export function hardenDirectory(path: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort, exactly as the Rust primitive is: a directory whose mode we
    // cannot set is still a directory we can write, and refusing to start over
    // it would be worse than the warning.
  }
}

/** 0600 on unix. */
export function hardenFile(path: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, 0o600);
  } catch {
    // See `hardenDirectory`.
  }
}

/**
 * The one primitive every private file goes through (contract §6).
 *
 * `create_dir_all` → directory 0700 → a temporary file named
 * `.{name}.tmp-{pid}` → **0600 at open time** → write → `fsync` → `rename` →
 * chmod once more.
 *
 * The TypeScript-specific trap is the second step. `fs.writeFile(path, data,
 * { mode })` applies the process umask to the mode *and* creates the file
 * before the mode is honoured on some platforms, so a secret can exist
 * world-readable for a moment. `open(..., "wx", 0o600)` asks the kernel for the
 * mode at creation; the chmod afterwards is the belt to that braces, because
 * the umask can still clear bits from the requested mode.
 *
 * `wx` also means a leftover temporary file is not silently written through —
 * it is removed first, which is a decision rather than an accident.
 */
export function writeSecret(path: string, contents: Buffer | string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  hardenDirectory(directory);
  const name = path.slice(directory.length + 1) || "file";
  const temporary = join(directory, `.${name}.tmp-${process.pid}`);
  rmSync(temporary, { force: true });
  const handle = openSync(temporary, "wx", 0o600);
  try {
    hardenFile(temporary);
    writeSync(
      handle,
      typeof contents === "string" ? Buffer.from(contents, "utf8") : contents,
    );
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
  hardenFile(path);
}
