/**
 * What the page learned from the Host, handed over verbatim
 * (ported from the Rust shell this one replaced).
 *
 * The shell does not speak the Host protocol; the settings page already holds
 * an authenticated session, so it asks and passes the answer along. Everything
 * here is still treated as untrusted input — see `offer.ts`.
 */

import type { Reason } from "./machine";
import { emptyAnswer, type HostAnswer } from "./offer";

export interface HostVerdict {
  /**
   * "available", "upToDate", "unavailable" or "unsupported". Anything else is
   * an answer this build does not understand, and becomes "unavailable".
   */
  state: string;
  reasonCode: string;
  retryAfterMs: number;
  checkedAtMs: number;
  /** The build target the Host answered about, "darwin-aarch64" and so on. */
  target: string;
  answer: HostAnswer;
}

/**
 * The Host's reason code as a shell reason. An unrecognized token lands in
 * "could not be confirmed" — never in "up to date".
 */
export function reasonFor(code: string): Reason {
  switch (code) {
    case "SOURCE_UNREACHABLE":
    case "UPDATES_NOT_CONFIGURED":
      return "sourceUnreachable";
    case "COMPATIBILITY_REFUSED":
      return "compatibilityRefused";
    case "NO_ARTIFACT_FOR_TARGET":
    case "CHANNEL_NOT_UPDATABLE":
      return "noArtifactForTarget";
    default:
      return "sourceMalformed";
  }
}

/**
 * The verdict as this build reads it, from whatever the page sent. A field of
 * the wrong type is a field that was not sent: the shell substitutes the value
 * that means "nothing was claimed" rather than trusting the shape.
 */
export function readVerdict(input: unknown): HostVerdict {
  const raw = (
    typeof input === "object" && input !== null ? input : {}
  ) as Record<string, unknown>;
  return {
    state: text(raw.state),
    reasonCode: text(raw.reasonCode),
    retryAfterMs: count(raw.retryAfterMs),
    checkedAtMs: count(raw.checkedAtMs),
    target: text(raw.target),
    answer: readAnswer(raw.answer),
  };
}

function readAnswer(input: unknown): HostAnswer {
  if (typeof input !== "object" || input === null) return emptyAnswer();
  const raw = input as Record<string, unknown>;
  const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts : [];
  return {
    version: text(raw.version),
    notesUrl: text(raw.notesUrl),
    artifacts: artifacts.map((entry) => {
      const each = (
        typeof entry === "object" && entry !== null ? entry : {}
      ) as Record<string, unknown>;
      return {
        component: text(each.component),
        target: text(each.target),
        url: text(each.url),
        sizeBytes: count(each.sizeBytes),
        sha256: text(each.sha256),
        signed: each.signed === true,
      };
    }),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
