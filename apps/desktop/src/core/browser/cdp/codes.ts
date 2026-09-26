/**
 * The stable refusal codes of the browser surface, and the error that carries
 * one.
 *
 * They used to live beside the `browser:drive` channel, because that channel
 * was the only thing that produced them. It is not any more: the same verb
 * runs against a `<webview>` guest in the desktop shell and against a headless
 * Chromium the core started itself, and a code is the part of a refusal a
 * caller branches on. A code whose spelling depends on which shell answered
 * would be two codes wearing one name.
 *
 * `shell-core/browser/drive.ts` re-exports the table so the wire protocol's
 * own file still reads as one document.
 */

export interface DriveError {
  readonly code: string;
  readonly message: string;
}

export const DRIVE_CODES = Object.freeze({
  /** No backend at all: no shell connected, and no browser to start. */
  unavailable: "browser_unavailable",
  notDrivable: "browser_not_drivable",
  discarded: "browser_discarded",
  staleRef: "browser_stale_ref",
  /** The page holds a JavaScript dialog open; only `dialog` gets through. */
  dialogPending: "browser_dialog_pending",
  notFound: "browser_not_found",
  refused: "browser_refused",
  badArgument: "browser_bad_argument",
  unknownVerb: "browser_unknown_verb",
  timeout: "browser_timeout",
  failed: "browser_failed",
});

export function driveError(code: string, message: string): DriveError {
  return { code, message };
}

/**
 * What a verb throws.
 *
 * A class rather than a `{ code, message }` return, because the throw travels
 * up through a dozen awaits inside one verb and every one of them would
 * otherwise have to forward it by hand.
 */
export class CdpRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "CdpRefusal";
  }
}

/** Throws one. Written as a `never` so a caller needs no `return` after it. */
export function refuse(code: string, message: string): never {
  throw new CdpRefusal(code, message);
}
