import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { Readable, Writable } from "node:stream";

/**
 * Starting a Chromium, and the one detail that makes it safe to start one at
 * all: `--remote-debugging-pipe`.
 *
 * The protocol runs on the child's file descriptors 3 and 4 — no port, no
 * loopback listener, nothing another process on the machine can connect to.
 * It also decides the lifetime: Chromium in pipe mode **exits when the pipe
 * closes**, so a core that dies takes its browsers with it without a
 * supervisor, a Job Object or a pid file. The explicit `kill` below is for the
 * ordinary case where the core is still alive and a node was closed.
 *
 * Each node gets its own `--user-data-dir`. That is where the logged-in
 * session of a browser node lives, which is the point of the node: a person
 * signs in once, and the agent drives a page that is already signed in. Two
 * nodes sharing a profile would be two nodes sharing an account.
 */

export interface LaunchOptions {
  readonly executable: string;
  readonly profileDir: string;
  readonly width: number;
  readonly height: number;
  /** Extra switches, for tests and for an operator who knows their machine. */
  readonly extraArgs?: readonly string[];
}

/** The half of a browser process this module's callers use. */
export interface BrowserProcess {
  readonly write: Writable;
  readonly read: Readable;
  readonly pid: number | undefined;
  kill(): void;
  onExit(handler: (code: number | null, signal: string | null) => void): void;
}

export type Launcher = (options: LaunchOptions) => BrowserProcess;

/**
 * The switches, and why each one is here.
 *
 * `--headless=new` is the Chromium that renders like the real browser rather
 * than the old headless shell, which is what makes a screencast of it worth
 * looking at. The rest is the ordinary automation set: no first-run UI, no
 * default-browser nagging, no crash reporter, no keychain prompt on a machine
 * with no desktop session to answer it.
 */
export function chromiumArgs(options: LaunchOptions): string[] {
  return [
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${options.profileDir}`,
    `--window-size=${options.width},${options.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-breakpad",
    "--metrics-recording-only",
    "--no-service-autorun",
    // A server shell has no desktop session to answer a keychain prompt, and
    // a browser blocked on one looks exactly like a browser that hung.
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    ...(options.extraArgs ?? []),
    "about:blank",
  ];
}

export const spawnChromium: Launcher = (options) => {
  mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });
  const child = spawn(options.executable, chromiumArgs(options), {
    // 0/1/2 as usual, then the CDP pair. `ignore` on stdin because Chromium
    // reads nothing, `pipe` on stderr so a launch failure has a message.
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    // Not detached: the browser belongs to this process's group, so a signal
    // that ends the core ends it too.
    detached: false,
    windowsHide: true,
  });
  const write = child.stdio[3] as Writable;
  const read = child.stdio[4] as Readable;
  return {
    write,
    read,
    pid: child.pid,
    kill: () => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    },
    onExit: (handler) => {
      child.on("exit", handler);
      child.on("error", () => handler(null, null));
    },
  };
};
