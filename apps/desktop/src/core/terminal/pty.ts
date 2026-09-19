import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { internal } from "./backend";

/**
 * The PTY, and the preflight that runs before one is asked for.
 *
 * `node-pty` is loaded through a function rather than a top-level import for
 * two reasons. It is a native module, so a build for the wrong ABI must fail
 * where a person can read the message — not while the route table is being
 * assembled. And every test in this directory that does not need a real pty
 * must be runnable on a machine where the module was never compiled.
 *
 * ## Why there is a preflight at all
 *
 * A spawn that fails inside node-pty leaks pty devices on macOS
 * (`apps/desktop/scripts/patch-node-pty.mjs` documents the measurement: one
 * `/dev/ptmx` per attempt, successful or not, against a `kern.tty.ptmx_max` of
 * 511). The patch closes that hole, but the patch only ships where the patch
 * ran, and "spawn it and see" is the wrong shape for a question — does this
 * program exist and may this user execute it — that `stat` answers for free.
 * So: resolve and check first, and turn a bad command into a 500 with a
 * readable message instead of `posix_spawnp failed.`.
 */

export interface PtyOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly cols: number;
  readonly rows: number;
  readonly name?: string;
}

export interface Pty {
  readonly pid: number;
  /**
   * With `encoding: null` node-pty hands back raw `Buffer`s even though its
   * own typings say `string`, which is the whole reason this interface is
   * declared here rather than imported.
   */
  onData(listener: (data: Buffer | string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ): Pty;
}

let cached: NodePtyModule | undefined;

/**
 * Loads `node-pty`, once.
 *
 * `require` rather than `import`: the core is bundled to CJS, the module is
 * external, and a dynamic `import()` of a native CJS addon from a CJS bundle
 * adds a microtask to every spawn for nothing.
 */
export function loadNodePty(): NodePtyModule {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require("node-pty") as NodePtyModule;
  } catch (error) {
    throw internal(
      `node-pty 无法加载，终端不可用：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return cached;
}

/** Test seam: hands the loader a stub without touching the real module. */
export function setNodePty(module: NodePtyModule | undefined): void {
  cached = module;
}

/**
 * Where `file` actually is, or `undefined`.
 *
 * `PATH` is the one the caller is about to hand the child, not the core's —
 * otherwise the preflight would approve a program the child cannot reach, or
 * reject one it can.
 */
export function resolveExecutable(
  file: string,
  env: Record<string, string>,
): string | undefined {
  const executable = (candidate: string): boolean => {
    try {
      if (!statSync(candidate).isFile()) return false;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (file.includes("/") || isAbsolute(file)) {
    return executable(file) ? file : undefined;
  }
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, file);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Everything that has to be true before node-pty is called. Throws a
 * {@link TerminalError} naming the one thing that is not.
 */
export function preflight(options: PtyOptions): void {
  let directory: boolean;
  try {
    directory = statSync(options.cwd).isDirectory();
  } catch {
    directory = false;
  }
  if (!directory) {
    throw internal(`终端的工作目录不存在：${options.cwd}`);
  }
  if (resolveExecutable(options.file, options.env) === undefined) {
    throw internal(`找不到可执行的程序：${options.file}`);
  }
  if (options.cols < 1 || options.rows < 1) {
    throw internal(`终端尺寸无效：${options.cols}x${options.rows}`);
  }
}

/**
 * Opens a pty after the preflight passes.
 *
 * `useConpty` is left to node-pty's own default; this batch never reaches the
 * Windows path (tmux is the only backend here), and forcing the flag from a
 * machine nobody has run it on would be a guess written down as a decision.
 */
export function openPty(options: PtyOptions): Pty {
  preflight(options);
  return loadNodePty().spawn(options.file, options.args, {
    name: options.name ?? "xterm-256color",
    cols: Math.max(2, Math.trunc(options.cols)),
    rows: Math.max(2, Math.trunc(options.rows)),
    cwd: options.cwd,
    // node-pty replaces the block wholesale — which is what
    // `childEnvironment` builds, so there is no inheritance to opt out of.
    env: options.env,
    // Bytes, not decoded strings: the socket owns the UTF-8 boundary problem
    // and a chunk that ends mid-character must survive the trip.
    encoding: null,
  });
}

/**
 * Releases a pty in the order that actually releases it.
 *
 * `pause()`d streams do not drain, and node-pty will not run its own teardown
 * until the read side is flowing again, so a paused pty that is killed leaks
 * both the fd and the reader thread. Resume, then let go of the JavaScript
 * side, then signal. Every step is guarded: this runs on the close path of a
 * socket that may already have lost its process, and a throw here would take
 * the handler's cleanup down with it.
 */
export function releasePty(pty: Pty | undefined, signal = "SIGHUP"): void {
  if (pty === undefined) return;
  try {
    pty.resume();
  } catch {
    // Already gone.
  }
  try {
    pty.kill(signal);
  } catch {
    // Already gone.
  }
}
