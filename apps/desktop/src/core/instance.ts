import { randomUUID } from "node:crypto";

/**
 * Which *run* of the core this process is.
 *
 * A shell starts a core and then probes the address in its data directory to
 * find out when it is ready. A version string cannot answer that question: a
 * core left behind by a shell that died three days ago reports `0.1.0` exactly
 * like the one that was just started, so the shell adopted the stale process
 * and every route added since came back 404.
 *
 * So every run mints an id nobody else can hold, publishes it on `/health` and
 * in `endpoints.json`, and writes it once on stdout before it binds anything.
 * The build stamp travels with it for diagnosis; identity is the id alone.
 *
 * The announcement line is byte-for-byte the one the Rust Runtime prints,
 * because `main/runtime-process.ts` parses both with one reader.
 */

/** The product version both implementations report. Asserted against `package.json`. */
export const VERSION = "0.1.0";

/**
 * Commit (or `version+timestamp`) this build came from.
 *
 * `ARMADRA_BUILD` is what a release pipeline sets; without it the stamp falls
 * back to the version and the second the process started, which is enough to
 * tell two runs apart in a log. Restricted to printable ASCII and 64
 * characters, because it has to survive on one line of the announcement.
 */
export const BUILD = buildStamp(process.env.ARMADRA_BUILD);

export function buildStamp(
  configured: string | undefined,
  now: () => number = Date.now,
): string {
  const raw =
    configured?.trim() || `${VERSION}+${Math.floor(now() / 1000).toString()}`;
  return [...raw]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x20 && code < 0x7f;
    })
    .slice(0, 64)
    .join("");
}

let minted: string | undefined;

/**
 * This process's instance id. Generated on first use and stable afterwards, so
 * a caller that asks late gets the same answer the shell was told.
 */
export function instanceId(): string {
  minted ??= randomUUID();
  return minted;
}

export const ANNOUNCE_PREFIX = "armadra-runtime instance ";

/**
 * The stdout line printed before anything is bound.
 *
 * Early on purpose: a core that *fails* to bind — because a stale one still
 * holds the socket — must still have told the shell who it was, or the shell
 * cannot tell "my child is starting" from "somebody else answered".
 */
export function announcement(): string {
  return `${ANNOUNCE_PREFIX}${instanceId()} build ${BUILD}`;
}

/**
 * The instance id in an announcement line, or `undefined` for any other line —
 * the same stdout carries ordinary log output.
 */
export function parseAnnouncement(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(ANNOUNCE_PREFIX)) return undefined;
  const id = trimmed.slice(ANNOUNCE_PREFIX.length).split(/\s+/)[0];
  return id ? id : undefined;
}
