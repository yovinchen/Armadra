/**
 * The bridge to the desktop shell's updater (design §4.2).
 *
 * Everything here is `isTauri() ? <shell> : unsupported`. A browser looking at
 * the same Host is not a thing that can be replaced by an installer, so it says
 * so rather than pretending: the settings page then shows the Host's answer and
 * how to install by hand.
 *
 * The shell owns the state; this module never keeps one of its own. A page that
 * cached the answer would keep rendering "downloading" after the shell had
 * already failed, which is exactly the kind of claim this feature must not
 * make.
 */
import { isTauri } from "../platform";

/** The eleven states of design §4.1, as the shell tags them. */
export type ShellUpdateState =
  | { state: "notConfigured"; missing: { pubkey: boolean; endpoints: boolean } }
  | { state: "localBuild" }
  | { state: "unsupported"; reason: ShellUnsupported }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "upToDate"; checkedAtMs: number }
  | {
      state: "unavailable";
      reason: ShellReason;
      retryAfterMs: number;
      checkedAtMs: number;
    }
  | { state: "available"; offer: ShellOffer }
  | {
      state: "downloading";
      offer: ShellOffer;
      receivedBytes: number;
      totalBytes: number;
    }
  | {
      state: "downloaded";
      offer: ShellOffer;
      phase: "ready" | "preparing" | "installing";
      problem: ShellReason | null;
    }
  | { state: "failed"; reason: ShellReason; offer: ShellOffer | null };

export type ShellUnsupported = "notDesktop" | "remoteHost" | "managedPackage";

/** The stable tokens the shell reports. Never a URL, never a message. */
export const SHELL_REASONS = [
  "sourceUnreachable",
  "sourceMalformed",
  "compatibilityRefused",
  "noArtifactForTarget",
  "signatureMismatch",
  "digestMismatch",
  "downloadInterrupted",
  "diskFull",
  "hostStopFailed",
  "installFailed",
  "updaterUnavailable",
] as const;

export type ShellReason = (typeof SHELL_REASONS)[number];

export interface ShellOffer {
  version: string;
  target: string;
  manifestUrl: string;
  packageUrl: string;
  sha256: string;
  sizeBytes: number;
  signed: boolean;
  notesUrl: string;
}

/** What the page learned from the Host, handed to the shell verbatim. */
export interface ShellHostVerdict {
  state: "available" | "upToDate" | "unavailable" | "unsupported";
  reasonCode: string;
  retryAfterMs: number;
  checkedAtMs: number;
  target: string;
  answer: {
    version: string;
    notesUrl: string;
    artifacts: {
      component: string;
      target: string;
      url: string;
      sizeBytes: number;
      sha256: string;
      signed: boolean;
    }[];
  };
}

/** Whether the last restart delivered what it promised (design §2.3). */
export type ShellRestartReport =
  | { outcome: "completed"; version: string }
  | {
      outcome: "incomplete";
      mismatched: ("shell" | "host" | "runtime")[];
      expectedVersion: string;
      previousVersion: string;
      previousPackageUrl: string;
    };

/** The answer for anything that is not the desktop shell. */
export const UNSUPPORTED_HERE: ShellUpdateState = {
  state: "unsupported",
  reason: "notDesktop",
};

async function invoke<T>(command: string, args?: unknown): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke(command, args as never)) as T;
  } catch (cause) {
    console.error(`${command} failed`, cause);
    return null;
  }
}

/** The state as the shell holds it. Reads nothing off the network. */
export async function shellState(): Promise<ShellUpdateState> {
  return (await invoke<ShellUpdateState>("updates_state")) ?? UNSUPPORTED_HERE;
}

/** Hands the Host's answer to the shell and returns the state it reached. */
export async function shellCheck(
  verdict: ShellHostVerdict,
): Promise<ShellUpdateState> {
  return (
    (await invoke<ShellUpdateState>("updates_check", { verdict })) ??
    UNSUPPORTED_HERE
  );
}

/** "Skip this version": drops the offer, claims nothing about newer ones. */
export async function shellDismiss(): Promise<ShellUpdateState> {
  return (
    (await invoke<ShellUpdateState>("updates_dismiss")) ?? UNSUPPORTED_HERE
  );
}

/**
 * Stops the transfer in flight and goes back to the offer.
 *
 * The bytes are discarded rather than kept: Tauri cannot resume, so a partial
 * package is not a head start on anything — it is a file that would have to be
 * fetched again in full.
 */
export async function shellCancel(): Promise<ShellUpdateState> {
  return (await invoke<ShellUpdateState>("updates_cancel")) ?? UNSUPPORTED_HERE;
}

/** Fetches and verifies the offered bundle. Installs nothing. */
export async function shellDownload(): Promise<ShellUpdateState> {
  return (
    (await invoke<ShellUpdateState>("updates_download")) ?? UNSUPPORTED_HERE
  );
}

/**
 * Stops what the shell owns and hands the bytes to the installer. On success
 * this never resolves: the process is replaced.
 */
export async function shellInstall(): Promise<ShellUpdateState> {
  return (
    (await invoke<ShellUpdateState>("updates_install")) ?? UNSUPPORTED_HERE
  );
}

/** `null` when no update was pending, which is the ordinary case. */
export async function shellRestartReport(): Promise<ShellRestartReport | null> {
  return await invoke<ShellRestartReport>("updates_restart_report");
}

export interface ShellProgress {
  receivedBytes: number;
  totalBytes: number;
}

/** The tray/notification announcement, mirrored to the page (design §4.1). */
export interface ShellStaged {
  ready: boolean;
  version: string;
}

/**
 * Subscribes to the shell's transfer progress. Returns the unsubscribe
 * function; on the web it is a no-op, because nothing there downloads.
 */
export function onShellProgress(
  callback: (progress: ShellProgress) => void,
): () => void {
  return onShellEvent("updates://progress", callback);
}

/**
 * Subscribes to the staged-update announcement — the same one the tray item
 * and the notification come from. The page uses it to re-read the state after
 * an `autoDownload` transfer nobody was watching.
 */
export function onShellStaged(
  callback: (staged: ShellStaged) => void,
): () => void {
  return onShellEvent("updates://staged", callback);
}

function onShellEvent<T>(name: string, callback: (payload: T) => void) {
  if (!isTauri()) return () => undefined;
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const stop = await listen<T>(name, (event) => callback(event.payload));
      if (cancelled) stop();
      else unlisten = stop;
    } catch (cause) {
      console.error(`listening to ${name} failed`, cause);
    }
  })();
  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = null;
  };
}
