/**
 * The update section's live state: the desktop shell's machine, plus the
 * periodic check that keeps it current (design §4.2, §5.3).
 *
 * The store holds no opinion of its own. It records what each side last said
 * and lets `mergeUpdatesState` decide what that means, so the rule about never
 * reporting "up to date" for a check that did not happen lives in one tested
 * function rather than in a component's conditionals.
 *
 * **The release side has no source in this build.** Until R7c the page asked a
 * separate Go Host over its own binary protocol; a single core answers no such
 * question yet — `core/updates` (design R5) was never written — so the release
 * side reports `noReleaseSource` and the merge keeps its promise: nothing here
 * ever reads as "this is the newest release" on the strength of a check that
 * did not happen. Installing a staged package, cancelling a transfer and the
 * restart report all still work, because those are the shell's own state.
 */
import { create } from "zustand";

import {
  onShellProgress,
  onShellStaged,
  shellCancel,
  shellDismiss,
  shellDownload,
  shellInstall,
  shellRestartReport,
  shellState,
  UNSUPPORTED_HERE,
  type ShellRestartReport,
  type ShellUpdateState,
} from "./shell-updater";
import type { HostRelease, HostSide } from "./state";

/** Design §2.1: after 30s, then every six hours, then whenever asked. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const FIRST_CHECK_DELAY_MS = 30_000;

/** The build target a release would be published for, from the browser. */
export function detectTarget(
  platform: string,
  userAgent: string,
): string | null {
  const haystack = `${platform} ${userAgent}`.toLowerCase();
  const system = haystack.includes("mac")
    ? "darwin"
    : haystack.includes("win")
      ? "windows"
      : haystack.includes("linux")
        ? "linux"
        : null;
  if (!system) return null;
  // "arm64" is what every one of the three reports; a browser never says which
  // ABI, which is why a target is asked about rather than a triple.
  const arch = /arm64|aarch64/.test(haystack) ? "aarch64" : "x86_64";
  return `${system}-${arch}`;
}

/** No release source: a statement about this build, not about any release. */
export const NO_RELEASE_SOURCE: HostSide = {
  kind: "blocked",
  reason: "noReleaseSource",
};

export interface UpdatesStore {
  host: HostSide;
  shell: ShellUpdateState;
  release: HostRelease | null;
  restart: ShellRestartReport | null;
  /** Started once per page; safe to call again. */
  start: () => () => void;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => Promise<void>;
  /** Stops a transfer or a check in flight and reports where that left it. */
  cancel: () => Promise<void>;
  acknowledgeRestart: () => void;
}

export const useUpdateState = create<UpdatesStore>((set, get) => {
  let started = false;

  return {
    host: NO_RELEASE_SOURCE,
    shell: UNSUPPORTED_HERE,
    release: null,
    restart: null,

    start() {
      if (started) return () => undefined;
      started = true;
      void (async () => {
        set({ shell: await shellState() });
        const report = await shellRestartReport();
        if (report) set({ restart: report });
      })();
      const stopProgress = onShellProgress((progress) => {
        // Progress is only meaningful while a transfer is the current state;
        // a late event must not resurrect one that already ended.
        const shell = get().shell;
        if (shell.state !== "downloading") return;
        set({ shell: { ...shell, ...progress } });
      });
      // The tray and the notification are driven by the same announcement. A
      // page that was not open when an `autoDownload` transfer finished reads
      // the state back rather than guessing it from the payload.
      const stopStaged = onShellStaged(() => {
        void (async () => set({ shell: await shellState() }))();
      });
      return () => {
        started = false;
        stopProgress();
        stopStaged();
      };
    },

    /**
     * Ask again. With no release source there is nothing to ask, so this
     * records that fact rather than leaving the section on a stale answer.
     */
    async check() {
      set({
        host: NO_RELEASE_SOURCE,
        release: null,
        shell: await shellState(),
      });
    },

    async download() {
      set({ shell: await shellDownload() });
    },

    async install() {
      set({ shell: await shellInstall() });
    },

    async dismiss() {
      set({ shell: await shellDismiss() });
    },

    async cancel() {
      const shell = await shellCancel();
      // A cancelled check leaves the Host side mid-request too; reporting it as
      // "checking" for ever would be the one thing this section must not do.
      if (get().host.kind === "checking") set({ host: { kind: "notAsked" } });
      set({ shell });
    },

    acknowledgeRestart() {
      set({ restart: null });
    },
  };
});
