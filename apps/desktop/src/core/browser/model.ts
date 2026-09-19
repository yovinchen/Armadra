/**
 * The domain types a browser session is described with.
 *
 * Ported from `apps/runtime/src/browser/model.rs`. Plain data with the
 * `camelCase` shape the front end and the event stream already read, so the
 * same session can be described over loopback JSON without a second
 * vocabulary.
 */

export type SessionState =
  | "starting"
  | "ready"
  /** The browser went away but the session is still supposed to exist. */
  | "disconnected"
  | "terminated"
  /** No usable browser on this execution host. */
  | "unsupported";

export function parseSessionState(value: string): SessionState {
  switch (value) {
    case "ready":
    case "starting":
    case "terminated":
    case "unsupported":
      return value;
    default:
      return "disconnected";
  }
}

/**
 * CSS pixels. The canvas scales the picture inside its shape; it never writes
 * its own zoom into the page viewport.
 */
export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
}

export const MIN_VIEWPORT = 200;
export const MAX_VIEWPORT = 4_000;

export function defaultViewport(): Viewport {
  return { width: 1024, height: 768, deviceScaleFactor: 1 };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * A viewport a client asked for, clamped to something a browser can actually
 * be told to render. A non-finite scale factor is 1 rather than a refusal: the
 * number came off a wire and the page still has to be drawn.
 */
export function clampViewport(viewport: Viewport): Viewport {
  return {
    width: clamp(viewport.width, MIN_VIEWPORT, MAX_VIEWPORT),
    height: clamp(viewport.height, MIN_VIEWPORT, MAX_VIEWPORT),
    deviceScaleFactor: Number.isFinite(viewport.deviceScaleFactor)
      ? clamp(viewport.deviceScaleFactor, 0.5, 3)
      : 1,
  };
}

/* ---------------------------------- lease --------------------------------- */

/**
 * Who is allowed to drive the page. One session, one holder.
 *
 * `humanTakeover` is not merely "a human with a longer lease": it is the state
 * a person enters deliberately, and it revokes the agent's lease instead of
 * making the agent wait. That difference is the whole reason there are two
 * human states rather than one.
 */
export type LeaseState = "free" | "human" | "humanTakeover" | "agent";

export interface LeaseHolder {
  /** `human` or `agent`. */
  readonly kind: "human" | "agent";
  /**
   * A viewer's own opaque id, or an agent's node id. Never an authenticated
   * identity, so it only ever tells holders apart.
   */
  readonly id: string;
  readonly displayName: string;
}

export interface Lease {
  readonly state: LeaseState;
  readonly generation: number;
  /**
   * RFC 3339, or empty when the state does not lapse on its own: a takeover is
   * held until the person hands it back.
   */
  readonly expiresAt: string;
  readonly holder?: LeaseHolder;
}

export function freeLease(generation: number): Lease {
  return { state: "free", generation, expiresAt: "" };
}

/** Structural equality, which is what "did the lease change?" means. */
export function sameLease(left: Lease, right: Lease): boolean {
  return (
    left.state === right.state &&
    left.generation === right.generation &&
    left.expiresAt === right.expiresAt &&
    left.holder?.kind === right.holder?.kind &&
    left.holder?.id === right.holder?.id &&
    left.holder?.displayName === right.holder?.displayName
  );
}

/**
 * One line of "who did what to this page" for the node header.
 *
 * Only the last few are kept, in memory. The durable record stays the board
 * log, which every agent action already writes.
 */
export interface Activity {
  readonly sessionId: string;
  /** `human` or `agent`. */
  readonly actor: "human" | "agent";
  readonly actorId: string;
  readonly verb: string;
  readonly target: string;
  /**
   * `ok`, `refused`, or `unknown` — the last for an action that was dispatched
   * and then had its lease revoked. It is never retried.
   */
  readonly outcome: "ok" | "refused" | "unknown";
  readonly reasonCode: string;
  readonly at: string;
}

/** How many activity lines one session remembers. */
export const ACTIVITY_CAPACITY = 20;

/* --------------------------------- dialogs -------------------------------- */

export type DialogKind = "alert" | "confirm" | "prompt" | "beforeunload";

export function parseDialogKind(value: string): DialogKind {
  switch (value) {
    case "confirm":
    case "prompt":
    case "beforeunload":
      return value;
    default:
      return "alert";
  }
}

export interface Dialog {
  readonly dialogId: string;
  readonly tabId: string;
  readonly kind: DialogKind;
  readonly message: string;
  readonly defaultPrompt: string;
  readonly url: string;
  readonly openedAt: string;
}

/**
 * A file chooser the page opened and nobody has answered yet. `accept` is the
 * page's hint for the picker, never a filter this side enforces.
 */
export interface FileChooser {
  readonly chooserId: string;
  readonly tabId: string;
  readonly frameId: string;
  readonly multiple: boolean;
  readonly accept: string;
  readonly openedAt: string;
}

/* -------------------------------- downloads ------------------------------- */

export type DownloadState =
  /** Staged outside the project and waiting for a human. */
  "pending" | "inProgress" | "completed" | "cancelled" | "failed";

export interface Download {
  readonly downloadId: string;
  readonly sessionId: string;
  readonly url: string;
  readonly suggestedFilename: string;
  readonly state: DownloadState;
  /** Workspace-relative, and only set once the download was accepted. */
  readonly path: string;
  readonly totalBytes: number;
  readonly receivedBytes: number;
  readonly createdAt: string;
  readonly reasonCode: string;
  /** Which tab produced it. */
  readonly tabId: string;
  /** Empty until the transfer finished: an in-flight digest would be wrong. */
  readonly sha256: string;
}

/* ---------------------------------- tabs ---------------------------------- */

/**
 * The tab id every action addresses. The core's own ordinal — a CDP `targetId`
 * is deliberately never handed out, because a caller that could name one could
 * address targets this module does not model.
 */
export interface Tab {
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
  readonly openerTabId: string;
  readonly navigationEpoch: number;
  readonly loading: boolean;
  readonly pendingDialog?: Dialog;
  /** The tab's icon as a `data:` URL, or empty. */
  readonly favicon: string;
}

export interface TabList {
  readonly tabs: readonly Tab[];
  readonly activeTabId: string;
  readonly limit: number;
}

/** One browser session, as every client sees it. */
export interface BrowserSession {
  readonly sessionId: string;
  readonly generation: number;
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly url: string;
  readonly title: string;
  readonly viewport: Viewport;
  readonly state: SessionState;
  /** Stable machine code, localized by the client. Empty when nothing is wrong. */
  readonly reasonCode: string;
  readonly navigationEpoch: number;
  readonly headful: boolean;
  readonly keepAlive: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Who may drive this session right now. Reads never consult it. */
  readonly lease: Lease;
  /** The stored counter the lease's generation continues from. */
  readonly leaseGeneration: number;
  readonly activeTabId: string;
  readonly tabCount: number;
  readonly pendingDialog?: Dialog;
  readonly pendingFileChooser?: FileChooser;
}
