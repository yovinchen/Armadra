/**
 * The update section's live state: the Host's answer, the shell's machine, and
 * the periodic check that keeps them current (design §4.2, §5.3).
 *
 * The store holds no opinion of its own. It records what each side last said
 * and lets `mergeUpdatesState` decide what that means, so the rule about never
 * reporting "up to date" for a check that did not happen lives in one tested
 * function rather than in a component's conditionals.
 */
import { create } from "zustand";
import {
  HostAutomationError,
  ReleaseChannel,
  UpdateSignatureState,
  formatVersion,
  parseVersion,
  type CheckForUpdateResponse,
} from "@armadra/host-client";

import { useUpdatesSession } from "../host/updates-session";
import {
  onShellProgress,
  onShellStaged,
  shellCancel,
  shellCheck,
  shellDismiss,
  shellDownload,
  shellInstall,
  shellRestartReport,
  shellState,
  UNSUPPORTED_HERE,
  type ShellHostVerdict,
  type ShellRestartReport,
  type ShellUpdateState,
} from "./shell-updater";
import { hostVerdictKind, type HostRelease, type HostSide } from "./state";

/** Design §2.1: after 30s, then every six hours, then whenever asked. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const FIRST_CHECK_DELAY_MS = 30_000;

/** The build target the Host answers about, from the browser's own platform. */
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
  // ABI, which is why the Host is asked about a target rather than a triple.
  const arch = /arm64|aarch64/.test(haystack) ? "aarch64" : "x86_64";
  return `${system}-${arch}`;
}

function signatureName(state: UpdateSignatureState | undefined) {
  switch (state) {
    case UpdateSignatureState.PRESENT:
      return "present" as const;
    case UpdateSignatureState.ABSENT:
      return "absent" as const;
    case UpdateSignatureState.UNCONFIGURED:
      return "unconfigured" as const;
    default:
      return "unknown" as const;
  }
}

const CHANNEL_NAMES: Record<number, string> = {
  [ReleaseChannel.UNSPECIFIED]: "unspecified",
  [ReleaseChannel.STABLE]: "stable",
  [ReleaseChannel.BETA]: "beta",
  [ReleaseChannel.DEVELOPMENT]: "development",
};

/** The offered release, as the section renders it. */
export function toHostRelease(
  response: CheckForUpdateResponse,
): HostRelease | null {
  const release = response.release;
  if (!release) return null;
  return {
    version: formatVersion(release.version),
    channel: CHANNEL_NAMES[response.channel] ?? "unspecified",
    notesUrl: release.notesUrl,
    sizeBytes: Number(release.artifacts[0]?.sizeBytes ?? 0n),
    signature: signatureName(release.artifacts[0]?.signature?.state),
  };
}

/** The Host's answer in the shape the shell reads it (design §2.2). */
export function toShellVerdict(
  response: CheckForUpdateResponse,
  target: string,
): ShellHostVerdict {
  const verdict = hostVerdictKind(response.state);
  return {
    // The shell knows four words; "unknown" is handed over as "unavailable",
    // which is how it must be treated on both sides.
    state: verdict === "unknown" ? "unavailable" : verdict,
    reasonCode: response.reasonCode,
    retryAfterMs: Number(response.retryAfterMs ?? 0n),
    checkedAtMs: Number(response.checkedAtUnixMs ?? 0n),
    target,
    answer: {
      version: formatVersion(response.release?.version),
      notesUrl: response.release?.notesUrl ?? "",
      artifacts: (response.release?.artifacts ?? []).map((artifact) => ({
        component: artifact.component,
        target: artifact.target,
        url: artifact.url,
        sizeBytes: Number(artifact.sizeBytes ?? 0n),
        sha256: hex(artifact.sha256),
        signed: artifact.signature?.state === UpdateSignatureState.PRESENT,
      })),
    },
  };
}

function hex(bytes: Uint8Array | undefined): string {
  if (!bytes) return "";
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export interface UpdatesStore {
  host: HostSide;
  shell: ShellUpdateState;
  release: HostRelease | null;
  restart: ShellRestartReport | null;
  /** Started once per page; safe to call again. */
  start: () => () => void;
  check: (input: {
    channel: "stable" | "beta";
    installedVersion: string;
  }) => Promise<void>;
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
    host: { kind: "notAsked" },
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

    async check({ channel, installedVersion }) {
      const session = useUpdatesSession.getState().state;
      if (session.status === "blocked") {
        set({
          host: { kind: "blocked", reason: session.reason },
          release: null,
        });
        return;
      }
      const version = parseVersion(installedVersion);
      if (session.status !== "ready" || !version) {
        set({ host: { kind: "notAsked" }, release: null });
        return;
      }
      const target = detectTarget(
        globalThis.navigator?.platform ?? "",
        globalThis.navigator?.userAgent ?? "",
      );
      set({ host: { kind: "checking" }, release: null });
      let response: CheckForUpdateResponse;
      try {
        response = await session.client.check({
          channel:
            channel === "beta" ? ReleaseChannel.BETA : ReleaseChannel.STABLE,
          installedVersion: version,
          // Empty: the Host answers about the machine it shares with this page
          // rather than a target guessed from a user agent. The shell is told
          // the detected one, because it is the thing being replaced.
          target: "",
          component: "desktop",
        });
      } catch (error) {
        set({ host: { kind: "failed", messageKey: failureKey(error) } });
        return;
      }
      const verdict = hostVerdictKind(response.state);
      set({
        host: {
          kind: "answered",
          verdict,
          reasonCode: response.reasonCode,
          retryAfterMs: Number(response.retryAfterMs ?? 0n),
          checkedAtMs: Number(response.checkedAtUnixMs ?? 0n),
          release: toHostRelease(response),
        },
        release: toHostRelease(response),
      });
      set({ shell: await shellCheck(toShellVerdict(response, target ?? "")) });
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

/** Turns a client failure into the one sentence that says what to do next. */
export function failureKey(error: unknown): string {
  if (!(error instanceof HostAutomationError)) return "updates.error.network";
  if (error.outcomeUnknown) return "updates.error.unknownOutcome";
  return `updates.error.${error.failure}`;
}
