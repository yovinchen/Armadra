import type { BackendKind } from "./backend";
import type { TmuxDetection } from "./tmux/config";

/**
 * The selection tree of contract §15.1, as one pure function.
 *
 * ```text
 * macOS / Linux
 * ├─ tmux >= 3.2 and the setting allows it   → tmux      (default)
 * └─ otherwise                                → direct
 * Windows
 * ├─ the setting explicitly says tmux, and tmux is usable → tmux
 * ├─ the setting says direct                              → direct
 * └─ otherwise                                            → sessionHost
 * ```
 *
 * Two rules in there are easy to get backwards, so they are written down:
 *
 *   * **On Windows `auto` never means tmux.** tmux there is an MSYS
 *     compatibility layer between Win32 CLIs and a Unix pty; the session host
 *     is the native answer. Asking for tmux explicitly still works.
 *   * **A session host that cannot be reached does not silently become
 *     `direct`.** Choosing it is a promise that terminals outlive the core,
 *     and quietly handing the user sessions that die with this process would
 *     break that promise without saying so. The backend is chosen here and
 *     fails loudly on the first terminal instead.
 *
 * Pure so that the whole table can be asserted without a tmux binary, a
 * Windows machine or a settings file — which is the only way the Windows
 * branch gets tested at all from here.
 */

export type BackendChoice = "auto" | "tmux" | "direct" | "sessionHost";

export interface BackendSelection {
  /** What will actually run. */
  readonly effective: BackendKind;
  /** What the user asked for. */
  readonly configured: BackendChoice;
  /** Why the effective backend is not the configured one, when it is not. */
  readonly reason?: string | undefined;
}

export function parseChoice(value: string): BackendChoice {
  return value === "tmux" || value === "direct" || value === "sessionHost"
    ? value
    : "auto";
}

export interface SelectOptions {
  readonly configured: BackendChoice;
  readonly detection: TmuxDetection;
  readonly platform?: string;
  /** False when this build has no session host to reach (non-Windows). */
  readonly sessionHostAvailable?: boolean;
}

export function selectBackend(options: SelectOptions): BackendSelection {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const { configured, detection } = options;
  const sessionHost = options.sessionHostAvailable ?? windows;

  if (configured === "direct") {
    return {
      effective: "direct",
      configured,
      reason: "terminal.backend 设为 direct",
    };
  }

  if (configured === "sessionHost") {
    if (sessionHost) return { effective: "sessionHost", configured };
    return {
      effective: detection.usable ? "tmux" : "direct",
      configured,
      reason: "这个平台没有会话宿主",
    };
  }

  if (configured === "tmux") {
    if (detection.usable) return { effective: "tmux", configured };
    return {
      effective: sessionHost ? "sessionHost" : "direct",
      configured,
      ...(detection.reason === undefined ? {} : { reason: detection.reason }),
    };
  }

  // `auto`.
  if (windows) {
    if (sessionHost) return { effective: "sessionHost", configured };
    return {
      effective: detection.usable ? "tmux" : "direct",
      configured,
      ...(detection.reason === undefined ? {} : { reason: detection.reason }),
    };
  }
  if (detection.usable) return { effective: "tmux", configured };
  return {
    effective: "direct",
    configured,
    ...(detection.reason === undefined ? {} : { reason: detection.reason }),
  };
}

/** `GET /api/terminals/backend` — contract §15.1. */
export interface BackendInfo {
  readonly effective: BackendKind;
  readonly configured: string;
  readonly tmuxVersion: string | null;
  readonly tmuxSocket: string | null;
  readonly reason: string | null;
  /**
   * `"unix"` or `"windows"`. The page needs it before it opens xterm: ConPTY
   * needs `windowsPty` set, and that option cannot be changed after `open()`
   * (contract §18.3, Windows row).
   */
  readonly platform: "unix" | "windows";
}
