import { execFile } from "node:child_process";

/**
 * The one seam between the core and whichever shell assembled it.
 *
 * The core is a service: everything a caller wants from it goes over HTTP or
 * WebSocket. What is left is the handful of things only a shell knows — where
 * its user data lives, whether it is packaged, where its resources are, how to
 * hand a URL to the desktop, how to raise a notification — and those arrive
 * here rather than through an `import "electron"`, which the core is forbidden
 * to write at all (`shell-core/no-electron.test.ts` scans `src/core/**`).
 *
 * Keeping it this narrow is what lets the same core run under a windowless
 * server shell later.
 */
export interface CorePlatform {
  /** The data directory this core was told to use. Already resolved. */
  readonly dataDir: string;
  /** The product version reported on `/health`. */
  readonly appVersion: string;
  /** Whether the assembling shell is a packaged application. */
  readonly isPackaged: boolean;
  /** Where a packaged shell staged read-only files. Absent in development. */
  readonly resourcesPath?: string | undefined;
  /** Three levels, filtered by `ARMADRA_LOG`. */
  readonly log: CoreLog;
  /** Hands a URL to the desktop. A server shell has nowhere to open one. */
  openExternal(url: string): Promise<void>;
  /**
   * One-way to the shell: tray notifications and update prompts. Never a
   * request — the core does not wait for a shell to answer.
   */
  notify(channel: string, payload: unknown): void;
}

export interface CoreLog {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LEVELS)[number];

/**
 * `ARMADRA_LOG` names the lowest level that is printed. The Rust `RUST_LOG`
 * grammar is deliberately not reproduced: one level is what anybody ever set.
 * An unrecognised value falls back to `info` rather than silencing the log.
 */
export function logLevel(configured: string | undefined): LogLevel {
  const wanted = configured?.trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(wanted ?? "")
    ? (wanted as LogLevel)
    : "info";
}

/**
 * Lines on stderr, so stdout stays the announcement channel the shell parses.
 */
export function createLog(
  level: LogLevel,
  write: (line: string) => void = (line) => process.stderr.write(line),
): CoreLog {
  const threshold = LEVELS.indexOf(level);
  const emit = (
    at: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ) => {
    if (LEVELS.indexOf(at) < threshold) return;
    const suffix = fields === undefined ? "" : ` ${JSON.stringify(fields)}`;
    write(
      `${new Date().toISOString()} ${at.toUpperCase()} ${message}${suffix}\n`,
    );
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

/**
 * The platform a core running as its own process assembles for itself: no
 * shell to ask, so `openExternal` shells out and `notify` only logs.
 *
 * An Electron shell replaces both with the real thing when it hosts the core
 * in-process; the fields above are the whole contract it has to satisfy.
 */
export function nodePlatform(options: {
  dataDir: string;
  appVersion: string;
  isPackaged?: boolean;
  resourcesPath?: string | undefined;
  log?: CoreLog;
}): CorePlatform {
  const log = options.log ?? createLog(logLevel(process.env.ARMADRA_LOG));
  return {
    dataDir: options.dataDir,
    appVersion: options.appVersion,
    isPackaged: options.isPackaged ?? false,
    resourcesPath: options.resourcesPath,
    log,
    openExternal: (url) => openExternal(url),
    notify: (channel, payload) => log.debug("notify", { channel, payload }),
  };
}

/**
 * Only `http(s)` and `mailto`, and only through the platform opener with the
 * URL as a separate argument — a string handed to a shell would let a crafted
 * link run a command.
 */
function openExternal(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(new Error(`not a URL: ${url}`));
  }
  if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) {
    return Promise.reject(new Error(`refusing to open ${parsed.protocol}`));
  }
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open"]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", ""]
        : ["xdg-open"];
  return new Promise((resolve, reject) => {
    execFile(command as string, [...args, parsed.toString()], (error) =>
      error ? reject(error) : resolve(),
    );
  });
}
