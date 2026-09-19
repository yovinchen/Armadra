/**
 * The desktop update state machine (design §2.1).
 *
 * A line-by-line port of `src-tauri/src/updates/machine.rs`. It is deliberately
 * free of Electron, of the network and of the clock: every transition is a pure
 * function of the current state and one event, so the table below is the whole
 * contract and a test can walk all of it.
 *
 * Two rules matter more than the rest, and the transition function is written
 * so they cannot be broken by adding a case:
 *
 * 1. **Nothing becomes `upToDate` except a check that came back saying so.**
 *    Not looking, failing to look, and looking and finding nothing are three
 *    different answers, and only the third one is "you are on the newest
 *    release".
 * 2. **An event a state does not accept changes nothing.** There is no
 *    fallthrough that lands somewhere plausible; an unexpected event is
 *    ignored and the state stays what it was.
 *
 * `preparing` and `installing` from the design's diagram are modelled as
 * phases of `downloaded` rather than as separate reported states: what the
 * settings page and the tray have to say is still "downloaded, waiting for a
 * restart", and folding them in keeps the reported set to the eleven states of
 * design §4.1 while preserving every transition of §2.1.
 *
 * The wire names — every state tag, every reason token, every field — are the
 * ones `apps/web/src/updates/shell-updater.ts:17-62` already reads. They are
 * not an implementation detail of this file; a rename here is a silently broken
 * settings page.
 */

/**
 * Why something could not be done, as a stable machine token.
 *
 * Never a URL, a response body or a transport message: an endpoint can carry a
 * token, and a reason a person reads is rendered from this word by the front
 * end, in their language.
 */
export const REASONS = [
  /** The release source could not be reached or read. */
  "sourceUnreachable",
  /** The source answered, but not with something this build can parse. */
  "sourceMalformed",
  /** A newer release exists and refuses this installed version. */
  "compatibilityRefused",
  /** The release publishes nothing for this target. */
  "noArtifactForTarget",
  /** The manifest entry is signed by a key this build does not carry. */
  "signatureMismatch",
  /** The bytes that arrived are not the bytes the release described. */
  "digestMismatch",
  /**
   * The transfer stopped before it finished. The bytes are discarded rather
   * than kept as a half download.
   */
  "downloadInterrupted",
  /** There was not enough room to stage the update. */
  "diskFull",
  /** The desktop-owned Host would not stop, so the install never started. */
  "hostStopFailed",
  /** The installer itself failed; the running version was not replaced. */
  "installFailed",
  /** The updater is present but unusable in this build. */
  "updaterUnavailable",
] as const;

export type Reason = (typeof REASONS)[number];

/**
 * Which half of the updater configuration is still missing. Both are needed
 * before a check means anything: an endpoint says where releases are
 * published, and — under Tauri — a public key is what made one trustworthy.
 *
 * Under electron-updater the `pubkey` half carries the same meaning one step
 * over: it is true when this build carries nothing that could make an update
 * trustworthy, which is now "the package is not signed" rather than "no
 * minisign key was configured". The name is kept because it is the wire format
 * the settings page renders (`updates.missing.pubkey`).
 */
export interface MissingUpdaterConfig {
  pubkey: boolean;
  endpoints: boolean;
}

export function anyMissing(missing: MissingUpdaterConfig): boolean {
  return missing.pubkey || missing.endpoints;
}

/** Why this shell cannot update itself at all, beyond configuration. */
export type Unsupported =
  /** The page is running in a browser, not in the desktop shell. */
  | "notDesktop"
  /**
   * The Host answering is not on this machine, so replacing this shell would
   * not be an update of anything the operator asked about.
   */
  | "remoteHost"
  /** The package manager that installed this build owns its updates. */
  | "managedPackage";

/**
 * What a release offers this target, once the Host's answer and the release
 * manifest agree about it.
 */
export interface Offer {
  version: string;
  target: string;
  /** The manifest of the same release, which is what the updater reads. */
  manifestUrl: string;
  /** The bundle the manifest points at, which is what actually gets applied. */
  packageUrl: string;
  /** Lowercase hex, 64 characters, as published for `packageUrl`. */
  sha256: string;
  sizeBytes: number;
  /**
   * The release published a signature for this bundle. It is a property of the
   * release, not a claim that anything was verified.
   */
  signed: boolean;
  notesUrl: string;
}

/** Where in the restart a `downloaded` update is. */
export type RestartPhase =
  /** Staged and idle; a person has not asked for the restart yet. */
  | "ready"
  /** Stopping the background this shell owns (design §2.3). */
  | "preparing"
  /** Handed to the installer. The process is expected to be replaced. */
  | "installing";

/** The eleven states the shell reports (design §4.1). */
export type UpdateState =
  /** Nothing trustworthy, no endpoint, or both. Nothing was consulted. */
  | { state: "notConfigured"; missing: MissingUpdaterConfig }
  /** A build that never went through CI. It never auto-updates. */
  | { state: "localBuild" }
  /** A shell that could not apply an update even if one existed. */
  | { state: "unsupported"; reason: Unsupported }
  /** Configured, and nothing has been asked yet. */
  | { state: "idle" }
  | { state: "checking" }
  | { state: "upToDate"; checkedAtMs: number }
  /** The check was made and did not produce an answer. Never "up to date". */
  | {
      state: "unavailable";
      reason: Reason;
      retryAfterMs: number;
      checkedAtMs: number;
    }
  | { state: "available"; offer: Offer }
  | {
      state: "downloading";
      offer: Offer;
      receivedBytes: number;
      totalBytes: number;
    }
  | {
      state: "downloaded";
      offer: Offer;
      phase: RestartPhase;
      /**
       * A restart that was started and did not get as far as installing. Kept
       * beside the offer so the page can explain why it came back.
       */
      problem: Reason | null;
    }
  | {
      state: "failed";
      reason: Reason;
      /**
       * Retained so "retry" has something to retry. The bytes are gone; the
       * offer is only a description of what to fetch again.
       */
      offer: Offer | null;
    };

/** Everything that can happen to an update. */
export type Event =
  /** A person pressed check, or the periodic timer fired. */
  | { type: "checkStarted" }
  /** A check in flight was abandoned. */
  | { type: "checkCancelled" }
  | { type: "checkedUpToDate"; atMs: number }
  | { type: "checkedAvailable"; offer: Offer }
  /** The Host or the manifest refused, with a reason and a retry hint. */
  | {
      type: "checkRefused";
      reason: Reason;
      retryAfterMs: number;
      atMs: number;
    }
  /**
   * "Skip this version": the offer is dropped without claiming anything about
   * whether a newer one exists.
   */
  | { type: "offerDismissed" }
  | { type: "downloadStarted" }
  | { type: "downloadProgressed"; receivedBytes: number; totalBytes: number }
  /** Signature and digest both passed; the bytes are on disk. */
  | { type: "downloadFinished" }
  | { type: "downloadFailed"; reason: Reason }
  /** A person confirmed "restart and update". */
  | { type: "restartRequested" }
  /** The desktop-owned background is stopped; the installer may run. */
  | { type: "backgroundStopped" }
  /** Stopping failed, or the person cancelled at the confirmation. */
  | { type: "restartAbandoned"; reason: Reason | null }
  | { type: "installFailed"; reason: Reason }
  /** "Try again" from a failure. */
  | { type: "retry" };

/**
 * Structural equality over the plain data above. `apply` reports whether the
 * state changed, and "changed" has to mean the value differs — not that a new
 * object was allocated, which is true of every branch below.
 */
export function sameState(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      sameState(left[key], right[key]),
  );
}

/**
 * The state plus the transition table. Holding it rather than a bare union
 * keeps `apply` the only way the state changes.
 */
export class Machine {
  private current: UpdateState;

  private constructor(state: UpdateState) {
    this.current = state;
  }

  /** A shell that has everything it needs and has not been asked yet. */
  static idle(): Machine {
    return new Machine({ state: "idle" });
  }

  /** A shell that was never given anything to trust, or anywhere to look. */
  static notConfigured(missing: MissingUpdaterConfig): Machine {
    return new Machine({ state: "notConfigured", missing: { ...missing } });
  }

  static localBuild(): Machine {
    return new Machine({ state: "localBuild" });
  }

  static unsupported(reason: Unsupported): Machine {
    return new Machine({ state: "unsupported", reason });
  }

  /** A machine already in a reported state, for the shell's own bootstrap. */
  static of(state: UpdateState): Machine {
    return new Machine(state);
  }

  state(): UpdateState {
    return this.current;
  }

  clone(): Machine {
    return new Machine(structuredClone(this.current));
  }

  /**
   * True while nothing about this build can ever change: these three states
   * describe the build, not a check, so no event moves out of them.
   */
  isTerminal(): boolean {
    return (
      this.current.state === "notConfigured" ||
      this.current.state === "localBuild" ||
      this.current.state === "unsupported"
    );
  }

  /**
   * Whether a check may start right now. A download or a pending restart is
   * not interrupted by one: the offer in hand is what the person acted on.
   */
  mayCheck(): boolean {
    switch (this.current.state) {
      case "idle":
      case "upToDate":
      case "unavailable":
      case "available":
      case "failed":
        return true;
      default:
        return false;
    }
  }

  /** The offer this state is about, if any. */
  offer(): Offer | null {
    switch (this.current.state) {
      case "available":
      case "downloading":
      case "downloaded":
        return this.current.offer;
      case "failed":
        return this.current.offer;
      default:
        return null;
    }
  }

  /**
   * Applies one event. Returns whether the state changed.
   *
   * Every arm is written out; there is no catch-all that guesses. An event
   * arriving in a state that does not list it is a race the caller lost — a
   * progress callback landing after a cancel, say — and losing a race must
   * never invent an answer.
   */
  apply(event: Event): boolean {
    const next = this.next(event);
    if (next === null || sameState(next, this.current)) return false;
    this.current = next;
    return true;
  }

  private next(event: Event): UpdateState | null {
    if (this.isTerminal()) return null;
    const state = this.current;

    // ---- checking ---------------------------------------------------------
    if (event.type === "checkStarted") {
      return this.mayCheck() ? { state: "checking" } : null;
    }
    if (state.state === "checking") {
      switch (event.type) {
        case "checkCancelled":
          return { state: "idle" };
        case "checkedUpToDate":
          return { state: "upToDate", checkedAtMs: event.atMs };
        case "checkedAvailable":
          return { state: "available", offer: event.offer };
        case "checkRefused":
          return {
            state: "unavailable",
            reason: event.reason,
            retryAfterMs: Math.max(event.retryAfterMs, 0),
            checkedAtMs: event.atMs,
          };
        default:
          return null;
      }
    }

    // ---- the offer --------------------------------------------------------
    if (state.state === "available") {
      switch (event.type) {
        case "offerDismissed":
          return { state: "idle" };
        case "downloadStarted":
          return {
            state: "downloading",
            offer: state.offer,
            receivedBytes: 0,
            totalBytes: state.offer.sizeBytes,
          };
        default:
          return null;
      }
    }
    if (state.state === "failed" && event.type === "retry") {
      return state.offer === null
        ? { state: "idle" }
        : { state: "available", offer: state.offer };
    }

    // ---- the transfer -----------------------------------------------------
    if (state.state === "downloading") {
      switch (event.type) {
        case "downloadProgressed":
          return {
            state: "downloading",
            offer: state.offer,
            receivedBytes: event.receivedBytes,
            // A server that reports no length leaves the offer's own size as
            // the best number there is; zero would render as a finished bar
            // the moment anything arrived.
            totalBytes:
              event.totalBytes === 0 ? state.offer.sizeBytes : event.totalBytes,
          };
        case "downloadFinished":
          return {
            state: "downloaded",
            offer: state.offer,
            phase: "ready",
            problem: null,
          };
        case "downloadFailed":
          return { state: "failed", reason: event.reason, offer: state.offer };
        case "checkCancelled":
          // Cancelling a download discards the bytes and keeps the offer: a
          // partial file is not something to resume from.
          return { state: "available", offer: state.offer };
        default:
          return null;
      }
    }

    // ---- the restart ------------------------------------------------------
    if (state.state === "downloaded") {
      if (state.phase === "ready" && event.type === "restartRequested") {
        return {
          state: "downloaded",
          offer: state.offer,
          phase: "preparing",
          problem: null,
        };
      }
      if (state.phase === "preparing" && event.type === "backgroundStopped") {
        return {
          state: "downloaded",
          offer: state.offer,
          phase: "installing",
          problem: null,
        };
      }
      if (state.phase === "preparing" && event.type === "restartAbandoned") {
        return {
          state: "downloaded",
          offer: state.offer,
          phase: "ready",
          problem: event.reason,
        };
      }
      if (state.phase === "installing" && event.type === "installFailed") {
        return { state: "failed", reason: event.reason, offer: state.offer };
      }
      return null;
    }

    return null;
  }
}
