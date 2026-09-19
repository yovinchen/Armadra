/**
 * Merging the two answers the update section has (design §4.1, §4.2).
 *
 * The Host decides whether a release is offered — it is the only side that
 * understands channels and the compatibility fence. The shell decides whether
 * anything can be installed — it is the only side holding a signing key. This
 * module is a pure function of the two, so the rule that matters can be tested
 * exhaustively:
 *
 * **No input combination produces "this is the newest release" unless both
 * sides said so.** A state this build does not recognize, a timeout, a session
 * it could not open, a reason code from a newer Host — all of them land in
 * "could not be confirmed" or "not configured". Not looking is not the same as
 * looking and finding nothing, and only the second one is reassuring.
 */
import type {
  ShellOffer,
  ShellReason,
  ShellUpdateState,
} from "./shell-updater";

/** The eleven rows of design §4.1. */
export type UpdatesViewState =
  | "notConfigured"
  | "localBuild"
  | "shellUnsupported"
  | "idle"
  | "checking"
  | "upToDate"
  | "unavailable"
  | "available"
  | "downloading"
  | "downloaded"
  | "failed";

/**
 * What a person may do from here. The page renders these in order.
 *
 * "cancel" stops a transfer by dropping the future the updater is running in —
 * the updater hands out no abort handle, so that is the whole of the mechanism. It
 * really does stop the bytes arriving, and it really does throw them away:
 * there is no resume, so the button says "cancel", not "pause".
 */
export type UpdatesAction =
  | "check"
  | "cancel"
  | "download"
  | "skip"
  | "restart"
  | "retry"
  | "notes"
  | "openHostSettings";

/**
 * The Host's side, already reduced to the vocabulary this module reasons in.
 * `unknown` is a real value: a Host newer than this build can answer with a
 * state that did not exist when this page was written.
 */
export type HostVerdictKind =
  | "upToDate"
  | "available"
  | "unsupported"
  | "unavailable"
  | "unknown";

export type HostSide =
  | { kind: "notAsked" }
  | { kind: "checking" }
  /** No session to ask with: signed out, no permission, wrong origin. */
  | { kind: "blocked"; reason: string }
  /** The request itself failed; `messageKey` is already an i18n key. */
  | { kind: "failed"; messageKey: string }
  | {
      kind: "answered";
      verdict: HostVerdictKind;
      reasonCode: string;
      retryAfterMs: number;
      checkedAtMs: number;
      /** The offered release, for the rows that describe it. */
      release: HostRelease | null;
    };

export interface HostRelease {
  version: string;
  channel: string;
  notesUrl: string;
  sizeBytes: number;
  signature: "present" | "absent" | "unconfigured" | "unknown";
}

export interface UpdatesView {
  state: UpdatesViewState;
  /** The one sentence that says where things stand. */
  statusKey: string;
  /** Extra sentences, already keys, in the order they should be read. */
  detailKeys: string[];
  actions: UpdatesAction[];
  offer: ShellOffer | null;
  release: HostRelease | null;
  progress: { receivedBytes: number; totalBytes: number } | null;
  retryAfterMs: number;
  checkedAtMs: number;
  /**
   * Set when one side answered and the other did not. "Up to date" is never
   * reported in that case; the answer that exists is shown, labelled.
   */
  partial: "hostNotChecked" | "shellNotChecked" | null;
}

/** The Host's numeric state as this build's vocabulary (`UpdateCheckState`). */
export function hostVerdictKind(state: number): HostVerdictKind {
  switch (state) {
    case 1:
      return "upToDate";
    case 2:
      return "available";
    case 3:
      return "unsupported";
    case 4:
      return "unavailable";
    // 0 is UNSPECIFIED, and anything above 4 is a Host newer than this page.
    // Neither is an answer, and neither may be read as one.
    default:
      return "unknown";
  }
}

/** Reason codes this build can explain. An unknown one is not printed raw. */
const KNOWN_REASONS = new Set([
  "UPDATES_NOT_CONFIGURED",
  "SOURCE_UNREACHABLE",
  "SOURCE_MALFORMED",
  "COMPATIBILITY_REFUSED",
  "NO_ARTIFACT_FOR_TARGET",
  "CHANNEL_NOT_UPDATABLE",
]);

export function reasonKey(reasonCode: string): string {
  return KNOWN_REASONS.has(reasonCode)
    ? `updates.reason.${reasonCode}`
    : "updates.reason.unknown";
}

/** The shell's own reason token as a sentence key. */
export function shellReasonKey(reason: ShellReason | null): string | null {
  return reason ? `updates.shellReason.${reason}` : null;
}

function view(
  partial: Partial<UpdatesView> & { state: UpdatesViewState },
): UpdatesView {
  return {
    statusKey: `updates.state.${partial.state}`,
    detailKeys: [],
    actions: [],
    offer: null,
    release: null,
    progress: null,
    retryAfterMs: 0,
    checkedAtMs: 0,
    partial: null,
    ...partial,
  };
}

/**
 * The section's state, from the Host's answer and the shell's.
 *
 * The order of the branches is the contract. The three that describe the build
 * come first, because no answer about a release changes them; only then does
 * the Host's inability to answer matter; only then is the shell's machine read.
 */
export function mergeUpdatesState(
  host: HostSide,
  shell: ShellUpdateState,
): UpdatesView {
  // ---- what this build is ------------------------------------------------
  if (shell.state === "notConfigured") {
    return view({
      state: "notConfigured",
      statusKey: "updates.state.unsupported",
      detailKeys: [
        shell.missing.pubkey ? "updates.missing.pubkey" : null,
        shell.missing.endpoints ? "updates.missing.endpoints" : null,
        ...hostNotes(host),
      ].filter((key): key is string => key !== null),
      actions: ["openHostSettings"],
    });
  }
  if (shell.state === "localBuild") {
    return view({
      state: "localBuild",
      statusKey: "updates.channel.development",
      detailKeys: ["updates.reason.CHANNEL_NOT_UPDATABLE"],
    });
  }
  if (shell.state === "unsupported") {
    // A browser, or a Host on another machine. The Host's answer is still worth
    // showing; installing is a manual act here.
    const release = host.kind === "answered" ? host.release : null;
    return view({
      state: "shellUnsupported",
      statusKey: "updates.state.shellUnsupported",
      detailKeys: [
        `updates.unsupported.${shell.reason}`,
        ...hostNotes(host),
        "updates.install.manual",
      ],
      release,
      actions: release?.notesUrl ? ["notes"] : [],
    });
  }

  // ---- the Host could not be asked ---------------------------------------
  if (host.kind === "blocked") {
    return view({
      state: "notConfigured",
      statusKey: "updates.state.unsupported",
      detailKeys: [`updates.blocked.${host.reason}`],
      actions: ["openHostSettings"],
    });
  }
  if (host.kind === "failed") {
    return view({
      state: "unavailable",
      detailKeys: [host.messageKey],
      actions: ["check"],
      partial: "hostNotChecked",
    });
  }
  if (host.kind === "checking" || shell.state === "checking") {
    return view({ state: "checking", actions: ["cancel"] });
  }
  if (host.kind === "notAsked" || shell.state === "idle") {
    return view({ state: "idle", actions: ["check"] });
  }

  // ---- both sides have something to say ----------------------------------
  const release = host.kind === "answered" ? host.release : null;
  const hostVerdict = host.kind === "answered" ? host.verdict : "unknown";
  const hostReason = host.kind === "answered" ? host.reasonCode : "";

  switch (shell.state) {
    case "upToDate":
      // The rule: both sides, or neither. A shell that found nothing while the
      // Host said something else is reported as unconfirmed, not as reassuring.
      if (hostVerdict === "upToDate") {
        return view({
          state: "upToDate",
          checkedAtMs: shell.checkedAtMs,
          actions: ["check"],
        });
      }
      return view({
        state: "unavailable",
        detailKeys: [reasonKey(hostReason)],
        checkedAtMs: shell.checkedAtMs,
        actions: ["check"],
        partial: "hostNotChecked",
      });
    case "unavailable":
      return view({
        state: "unavailable",
        detailKeys: [
          reasonKey(hostReason),
          shellReasonKey(shell.reason),
        ].filter((key): key is string => key !== null),
        retryAfterMs: shell.retryAfterMs,
        checkedAtMs: shell.checkedAtMs,
        actions: ["check"],
      });
    case "available":
      return view({
        state: "available",
        offer: shell.offer,
        release,
        actions: [
          "download",
          "skip",
          ...(shell.offer.notesUrl || release?.notesUrl
            ? (["notes"] as const)
            : []),
        ],
      });
    case "downloading":
      return view({
        state: "downloading",
        offer: shell.offer,
        release,
        progress: {
          receivedBytes: shell.receivedBytes,
          totalBytes: shell.totalBytes,
        },
        // Cancelling goes back to the offer, so nothing about the release is
        // lost — only the partial file, which was worth nothing anyway.
        actions: ["cancel"],
      });
    case "downloaded":
      return view({
        state: "downloaded",
        offer: shell.offer,
        release,
        detailKeys: [
          "updates.downloaded.note",
          shellReasonKey(shell.problem),
        ].filter((key): key is string => key !== null),
        // While the restart is under way there is nothing left to press, and
        // offering "restart" again would start a second one.
        actions: shell.phase === "ready" ? ["restart"] : [],
      });
    case "failed":
      return view({
        state: "failed",
        offer: shell.offer,
        release,
        detailKeys: [shellReasonKey(shell.reason)].filter(
          (key): key is string => key !== null,
        ),
        actions: shell.offer ? ["retry", "notes"] : ["check"],
      });
    default:
      // Unreachable for a shell this page understands. A state from a newer
      // shell is "could not be confirmed", never "up to date".
      return view({ state: "unavailable", actions: ["check"] });
  }
}

/** The Host's own sentence, when it has one worth adding. */
function hostNotes(host: HostSide): string[] {
  if (host.kind === "blocked") return [`updates.blocked.${host.reason}`];
  if (host.kind === "failed") return [host.messageKey];
  if (host.kind === "answered" && host.verdict !== "upToDate") {
    return [reasonKey(host.reasonCode)];
  }
  return [];
}

/** "3.2 MB / 8.0 MB", for the transfer row. Never a percentage of zero. */
export function formatProgress(received: number, total: number): string {
  const mib = (value: number) => `${(value / 1_048_576).toFixed(1)} MB`;
  return total > 0 ? `${mib(received)} / ${mib(total)}` : mib(received);
}
