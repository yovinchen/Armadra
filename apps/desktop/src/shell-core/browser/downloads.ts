/**
 * Where a download goes, and how long a staged one may sit there.
 *
 * Two kinds of download reach one `will-download` listener, and they are not
 * the same event:
 *
 *   * **A person clicked a link.** That is an ordinary browser download and
 *     it belongs in the system downloads directory, under a name the page
 *     suggested, with no dialog and no queue to go and approve. The staging
 *     path had no page that could accept a download, so this case used to end
 *     in a file nobody could reach.
 *   * **An agent's verb caused it.** Those still stage: bytes a page chose
 *     must not enter a project because a driven page asked for them, and
 *     `download --accept` is the one thing that writes them there.
 *
 * Everything below is PURE so the naming and the expiry rules can be tested
 * without a session, a download item or a clock.
 */

import { basename, extname, join } from "node:path";

/**
 * How long a staged download may sit in the staging directory.
 *
 * The staging directory used to have no expiry at all, on the argument that a
 * queue which empties itself loses the thing a person was about to look at.
 * That argument belonged to a queue a person could see. Nothing in the
 * product shows staged downloads to a person — only an agent's
 * `download` verb lists them — so what the absence of an expiry actually
 * produced was an unbounded directory of files nobody will ever name again.
 * A day is long enough to outlive any single agent run.
 */
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * PURE. A page's suggested filename, made into something that is ONLY a
 * filename.
 *
 * Unlike the staged name, this one keeps the characters a person reads:
 * a downloaded `报告.pdf` is called that in their downloads directory. What
 * is removed is everything that could make the string mean a path rather than
 * a name — separators, `..`, NUL and the other control characters — plus a
 * leading dot, which would hide the file from the window that is about to
 * open on it.
 */
export function userDownloadName(raw: unknown): string {
  if (typeof raw !== "string") return "download";
  const cleaned = basename(raw.replace(/[\\/]+/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.slice(0, 120) || "download";
}

/**
 * PURE. `directory/name`, numbered if something is already there.
 *
 * Numbering rather than a Save dialog: Electron shows the dialog exactly when
 * no save path was set, and a dialog for every download is not what a browser
 * does. The suffix goes BEFORE the extension (`report (1).pdf`), which is
 * what every file manager and every browser produces, so the file still opens
 * in the application its extension names.
 *
 * `exists` is injected so the rule can be tested without a filesystem; the
 * caller passes `existsSync`.
 */
export function uniqueDownloadPath(
  directory: string,
  name: string,
  exists: (path: string) => boolean,
): string {
  const first = join(directory, name);
  if (!exists(first)) return first;
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  // The bound is a stop, not a policy: a directory with a thousand copies of
  // one name is a loop somewhere else, and overwriting is still not an option.
  for (let index = 1; index < 1000; index += 1) {
    const candidate = join(directory, `${stem} (${index})${extension}`);
    if (!exists(candidate)) return candidate;
  }
  return join(directory, `${stem} (${Date.now()})${extension}`);
}

/** One entry of the staging directory, as far as the expiry rule cares. */
export interface StagedEntry {
  readonly name: string;
  /** Last modification, in milliseconds since the epoch. */
  readonly modifiedAtMs: number;
}

/**
 * PURE. Which staged files are old enough to delete.
 *
 * A file whose timestamp is in the FUTURE is kept: a clock that moved
 * backwards, or a filesystem with a coarse timestamp, must not be a reason to
 * delete something that was written a second ago.
 */
export function expiredStagedFiles(
  entries: readonly StagedEntry[],
  nowMs: number,
  maxAgeMs: number = STAGING_MAX_AGE_MS,
): string[] {
  return entries
    .filter((entry) => nowMs - entry.modifiedAtMs > maxAgeMs)
    .map((entry) => entry.name);
}
