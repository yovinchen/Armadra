import { prepareNewDirectory, validDirectoryName } from "../workspaces/roots";
import { uuidV7 } from "../workspaces/support";
import { progressPercent, runGit } from "./command";
import { badRequest, conflict, notFound, sanitize } from "./support";

/**
 * Background `git clone` jobs: validation, progress and cancellation.
 *
 * A port of `apps/runtime/src/git/clone.rs`. Clone jobs exist before any
 * workspace does, so they cannot hang off the per-workspace event hub; the
 * dialog polls `GET /api/git/clone/{jobId}` instead.
 */

/** A clone may not run forever: the job is killed and marked failed after this. */
const CLONE_TIMEOUT_MS = 15 * 60 * 1000;
/** Only the tail of `git clone --progress` is kept; the dialog shows one line. */
const CLONE_MAX_LINES = 20;
/** Finished jobs are dropped this long after they stop. */
const CLONE_RETENTION_MS = 30 * 60 * 1000;
const MAX_ACTIVE_CLONES = 16;

export type CloneState = "running" | "done" | "error";

export interface CloneStatus {
  readonly state: CloneState;
  readonly lines: string[];
  readonly error: string | null;
  /** Where the repository landed; the workspace is created from it. */
  readonly target: string;
  /** The directory name, which becomes the workspace name. */
  readonly name: string;
  /**
   * Whether the job stopped because somebody asked it to. A separate fact from
   * `state`, which only knows the process did not succeed: a cancelled clone
   * and a failed one need different words in front of a person.
   */
  readonly cancelled: boolean;
  /** The URL with any credential removed. */
  readonly displayUrl: string;
  /**
   * 0–100, read from `git clone --progress`. A display value: Git reports
   * several phases and this is the newest percentage any of them printed, so it
   * can stall and it never goes backwards on its own.
   */
  readonly percent: number;
}

interface CloneJob {
  state: CloneState;
  lines: string[];
  error: string | null;
  target: string;
  name: string;
  displayUrl: string;
  percent: number;
  controller: AbortController;
  cancelled: boolean;
  finishedAt: number | undefined;
}

const JOBS = new Map<string, CloneJob>();

export interface CloneStarted {
  readonly jobId: string;
  readonly target: string;
}

/**
 * Characters a repository URL may contain. Git never sees a shell here, but
 * the allow-list also rules out the argument- and CRLF-injection shapes.
 */
function cloneUrlChar(character: string): boolean {
  return /[A-Za-z0-9]/.test(character) || "-._~:/@%+=,".includes(character);
}

/**
 * Accept `https://host/path`, `ssh://[user@]host/path` and `user@host:path`
 * only. Anything else — `file://`, `http://`, `ext::`, a local path, a leading
 * dash — is refused.
 */
export function validateCloneUrl(raw: string): string {
  const url = raw.trim();
  const invalid = (): Error => badRequest("Repository URL is invalid");
  if (
    url === "" ||
    url.length > 2_048 ||
    ![...url].every((character) => cloneUrlChar(character))
  ) {
    throw invalid();
  }
  let rest: string;
  if (url.startsWith("https://")) rest = url.slice("https://".length);
  else if (url.startsWith("ssh://")) rest = url.slice("ssh://".length);
  else {
    // scp-like `user@host:path`; the `@` must come before the first `:`.
    const at = url.indexOf("@");
    if (at < 0) throw invalid();
    const user = url.slice(0, at);
    const remainder = url.slice(at + 1);
    const colon = remainder.indexOf(":");
    if (colon < 0) throw invalid();
    const host = remainder.slice(0, colon);
    const path = remainder.slice(colon + 1);
    if (user === "" || host === "" || path === "" || host.includes("/")) {
      throw invalid();
    }
    return url;
  }
  const slash = rest.indexOf("/");
  if (slash < 0) throw invalid();
  const authority = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  if (host === "" || path === "") throw invalid();
  return url;
}

/** `https://host/o/repo.git` → `repo`. */
export function cloneDirectoryName(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  let tail = trimmed;
  for (const separator of ["/", ":"]) {
    const index = tail.lastIndexOf(separator);
    if (index >= 0) tail = tail.slice(index + 1);
  }
  const name = tail.endsWith(".git") ? tail.slice(0, -4) : tail;
  return validDirectoryName(name);
}

/**
 * Validate the request and spawn `git clone --progress` in the background.
 *
 * Returns as soon as the child is running: the caller polls
 * {@link cloneStatus} and creates the workspace once the job reports `done`.
 */
export function startClone(
  url: string,
  parent: string,
  name: string | undefined,
): CloneStarted {
  return startCloneFrom(validateCloneUrl(url), parent, name);
}

/**
 * The same, for a source the caller has already decided it may clone.
 *
 * This entry point exists so that decision is made once, where the root is
 * known, instead of being re-derived by loosening the allow-list for everybody.
 */
export function startCloneFrom(
  source: string,
  parent: string,
  name: string | undefined,
): CloneStarted {
  const trimmed = name?.trim();
  const directory =
    trimmed === undefined || trimmed === ""
      ? cloneDirectoryName(source)
      : validDirectoryName(trimmed);
  const target = prepareNewDirectory(parent, directory);
  return spawnCloneJob(source, directory, target);
}

/**
 * The half that actually runs Git, split out so a test can point it at a local
 * bare repository without loosening {@link validateCloneUrl}.
 */
export function spawnCloneJob(
  url: string,
  name: string,
  target: string,
): CloneStarted {
  for (const [id, job] of [...JOBS]) {
    if (
      job.finishedAt !== undefined &&
      Date.now() - job.finishedAt > CLONE_RETENTION_MS
    ) {
      JOBS.delete(id);
    }
  }
  if (
    [...JOBS.values()].filter((job) => job.state === "running").length >=
    MAX_ACTIVE_CLONES
  ) {
    throw conflict("Too many active clone jobs");
  }
  const jobId = uuidV7();
  const controller = new AbortController();
  const job: CloneJob = {
    state: "running",
    lines: [],
    error: null,
    target,
    name,
    // The credential is removed here, by the side that has the original.
    displayUrl: sanitize(url),
    percent: 0,
    controller,
    cancelled: false,
    finishedAt: undefined,
  };
  JOBS.set(jobId, job);
  void runGit({
    cwd: process.cwd(),
    args: ["clone", "--progress", "--", url, target],
    timeoutMs: CLONE_TIMEOUT_MS,
    signal: controller.signal,
    onStderrLine: (raw) => pushCloneLine(job, raw),
  })
    .then((output) => {
      job.finishedAt = Date.now();
      if (job.cancelled) {
        job.state = "error";
        job.error =
          "Git clone cancelled; any partial destination was kept for inspection";
        return;
      }
      if (output.status === 0) {
        job.state = "done";
        return;
      }
      job.state = "error";
      job.error = job.lines[job.lines.length - 1] ?? "Git clone failed";
    })
    .catch((error: unknown) => {
      job.finishedAt = Date.now();
      if (job.cancelled) {
        job.state = "error";
        job.error =
          "Git clone cancelled; any partial destination was kept for inspection";
        return;
      }
      job.state = "error";
      job.error = sanitize(
        error instanceof Error ? error.message : String(error),
      );
    });
  return { jobId, target };
}

function pushCloneLine(job: CloneJob, raw: string): void {
  const trimmed = raw.trim();
  if (trimmed === "") return;
  const line = sanitize(trimmed);
  if (job.lines.length === CLONE_MAX_LINES) job.lines.shift();
  job.lines.push(line);
  const percent = progressPercent(line);
  if (percent !== undefined) job.percent = percent;
}

export function cloneStatus(jobId: string): CloneStatus {
  const job = JOBS.get(jobId);
  if (job === undefined) throw notFound("That clone job is unknown");
  return {
    state: job.state,
    lines: [...job.lines],
    error: job.error,
    target: job.target,
    name: job.name,
    cancelled: job.cancelled,
    displayUrl: job.displayUrl,
    // A finished clone is at 100 even when Git's last line stopped short of
    // printing it: a bar frozen at 97% is a worse lie than one that completes.
    percent: job.state === "done" ? 100 : job.percent,
  };
}

/** How many clones this process still has running. */
export function activeCloneCount(): number {
  return [...JOBS.values()].filter((job) => job.state === "running").length;
}

/**
 * Request cancellation of exactly this clone's child. A final destination is
 * user-visible and may have changed, so cancellation never recursively deletes
 * it.
 */
export function cancelClone(jobId: string): void {
  const job = JOBS.get(jobId);
  if (job === undefined) throw notFound("That clone job is unknown");
  if (job.state !== "running") return;
  job.cancelled = true;
  job.error =
    "Git clone cancellation requested; any partial destination will be preserved";
  job.controller.abort();
}

/** Drops every record, so one test's jobs cannot be seen by the next. */
export function resetCloneJobs(): void {
  JOBS.clear();
}
