import { statSync } from "node:fs";
import {
  canonicalDirectory,
  contains,
  resolveInRoot,
} from "../../workspaces/roots";
import { gitArguments } from "../access";
import {
  type CommandOutput,
  REPOSITORY_PREFIX,
  REPOSITORY_STDERR_LIMIT,
  REPOSITORY_STDOUT_LIMIT,
  progressPercent,
  runGit,
} from "../command";
import {
  badRequest,
  conflict,
  forbidden,
  internalError,
  malformed,
  notFound,
  nowRfc3339,
  oneLine,
  requireExecution,
  sanitizeRepository,
  sha256Hex,
  shuttingDown,
  validOid,
} from "../support";
import { fieldsWithLf } from "./parse";
import {
  type ExpectedState,
  type OperationSnapshot,
  type OperationState,
  type RepositoryAction,
  isTerminal,
} from "./types";

/**
 * Repository operations for the core.
 *
 * A port of the pre-merge implementation. Git stays authoritative:
 * the common-directory lock coordinates *this* service and the callers holding
 * a {@link RepositoryGuard}, never external `git` processes, and an interrupted
 * mutation is an unknown outcome rather than an automatic retry.
 *
 * What the Rust module solved with a `tokio::sync::Mutex` per common directory
 * and a registry of operations is solved the same way here, with one
 * difference worth naming: there is no second runtime to bridge, so an
 * operation is a plain async function whose cancellation travels on an
 * `AbortSignal`.
 */

const MAX_OPERATIONS = 256;
export const MAX_HISTORY_PAGE = 200;

export interface RepositoryContext {
  readonly workspaceRoot: string;
  readonly repository: string;
  readonly commonDir: string;
}

/** SHA-256 of the canonical common directory — the id every snapshot reports. */
export function repositoryId(context: RepositoryContext): string {
  return sha256Hex(context.commonDir);
}

/** One entry of the in-memory queue, with the parts that change while it runs. */
export interface Operation {
  snapshot: OperationSnapshot;
  readonly controller: AbortController;
  /** Set as soon as a mutating child exists: from here the outcome is unknown. */
  mutationStarted: boolean;
  awaitingResolution: boolean;
  /** The newest percentage the running `git --progress` reported. */
  progress: number;
}

export interface IntegrationOwner {
  readonly sessionId: string;
  readonly kind: string;
  readonly mainline: number | null;
  readonly original: ExpectedState;
  readonly targetOid: string;
  marker: MarkerIdentity | null;
}

export interface MarkerIdentity {
  readonly digest: string;
  readonly createdMs: number | null;
  readonly modifiedMs: number | null;
  readonly deviceInode: string | null;
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** FIFO: the position is reserved the moment `acquire` is called. */
  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waited = this.tail.then(() => release);
    this.tail = this.tail.then(() => next);
    return waited;
  }
}

interface Lifecycle {
  stopping: boolean;
  activeGuards: number;
}

export class RepositoryGuard {
  constructor(
    readonly context: RepositoryContext,
    private readonly release: () => void,
    private readonly service: RepositoryService,
  ) {}

  dispose(): void {
    this.release();
    this.service.releaseGuard();
  }
}

export interface RepositoryServiceOptions {
  readonly commandTimeoutMs?: number;
  readonly allowHelpers?: boolean;
  /** The askpass helper `core/remote` publishes, threaded into every child. */
  readonly askpass?: () => string | undefined;
}

export class RepositoryService {
  private readonly locks = new Map<string, Mutex>();
  private readonly operations = new Map<string, Operation>();
  private readonly order: string[] = [];
  readonly integrations = new Map<string, IntegrationOwner>();
  private readonly lifecycle: Lifecycle = { stopping: false, activeGuards: 0 };
  private readonly stopping = new AbortController();
  readonly commandTimeoutMs: number;
  readonly allowHelpers: boolean;
  private readonly askpass: () => string | undefined;

  constructor(options: RepositoryServiceOptions = {}) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
    this.allowHelpers = options.allowHelpers ?? true;
    this.askpass = options.askpass ?? (() => undefined);
  }

  /**
   * A view of this service with the workspace's execution grant applied.
   *
   * It affects only this view's typed Git commands — never the shared locks,
   * the operation registry or another caller's children, all of which stay on
   * the one underlying service.
   */
  withExecution(execute: boolean): RepositoryService {
    if (execute === this.allowHelpers) return this;
    const view: RepositoryService = Object.create(
      RepositoryService.prototype,
    ) as RepositoryService;
    Object.assign(view, this, { allowHelpers: execute });
    return view;
  }

  isShuttingDown(): boolean {
    return this.lifecycle.stopping;
  }

  releaseGuard(): void {
    this.lifecycle.activeGuards -= 1;
  }

  private lockFor(directory: string): Mutex {
    const existing = this.locks.get(directory);
    if (existing !== undefined) return existing;
    const lock = new Mutex();
    this.locks.set(directory, lock);
    return lock;
  }

  /**
   * Hold this across index / worktree writes so they share the queue every
   * repository operation is serialized by.
   */
  async mutationGuard(
    workspaceRoot: string,
    requested: string,
  ): Promise<RepositoryGuard> {
    const context = await this.context(workspaceRoot, requested);
    const release = await this.lockFor(context.commonDir).acquire();
    try {
      await this.revalidateContext(context);
      if (this.lifecycle.stopping) throw shuttingDown();
    } catch (error) {
      release();
      throw error;
    }
    this.lifecycle.activeGuards += 1;
    return new RepositoryGuard(context, release, this);
  }

  /** Runs `work` while holding the repository's lock, releasing it after. */
  async withGuard<T>(
    workspaceRoot: string,
    requested: string,
    work: (guard: RepositoryGuard) => Promise<T>,
  ): Promise<T> {
    const guard = await this.mutationGuard(workspaceRoot, requested);
    try {
      return await work(guard);
    } finally {
      guard.dispose();
    }
  }

  async context(
    workspaceRoot: string,
    requested: string,
    signal?: AbortSignal,
  ): Promise<RepositoryContext> {
    const root = canonicalDirectory(workspaceRoot);
    const directory = resolveInRoot(root, requested);
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
      throw badRequest("Git path must be a directory");
    }
    const inside = await this.output(
      directory,
      ["rev-parse", "--is-inside-work-tree"],
      Math.min(this.commandTimeoutMs, 15_000),
      signal,
    );
    if (inside.status !== 0) {
      if (inside.stderr.toString("utf8").includes("not a git repository")) {
        throw badRequest("Path is not a Git working repository");
      }
      throw commandError(inside);
    }
    if (oneLine(inside.stdout) !== "true") {
      throw badRequest("Path is not a working Git repository");
    }
    const top = await this.read(
      directory,
      ["rev-parse", "--show-toplevel"],
      signal,
    );
    const repository = canonicalDirectory(oneLine(top));
    if (!startsInside(root, repository)) {
      throw forbidden("Git repository is outside the authorized workspace");
    }
    const common = await this.read(
      repository,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      signal,
    );
    return {
      workspaceRoot: root,
      repository,
      commonDir: canonicalDirectory(oneLine(common)),
    };
  }

  async revalidateContext(
    context: RepositoryContext,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = await this.context(
      context.workspaceRoot,
      context.repository,
      signal,
    );
    if (
      current.workspaceRoot !== context.workspaceRoot ||
      current.repository !== context.repository ||
      current.commonDir !== context.commonDir
    ) {
      throw conflict(
        "Repository location changed while the operation was queued",
      );
    }
  }

  /* ------------------------------- commands ------------------------------- */

  async output(
    directory: string,
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
    options: {
      readonly environment?: Readonly<Record<string, string>>;
      readonly onMutationStarted?: () => void;
      readonly onProgress?: (percent: number) => void;
    } = {},
  ): Promise<CommandOutput> {
    if (this.lifecycle.stopping) throw shuttingDown();
    const prepared = gitArguments(args, this.allowHelpers);
    const askpass = this.askpass();
    return runGit({
      cwd: directory,
      prefix: REPOSITORY_PREFIX,
      args: prepared,
      timeoutMs,
      stdoutLimit: REPOSITORY_STDOUT_LIMIT,
      stderrLimit: REPOSITORY_STDERR_LIMIT,
      environment: {
        restrict: !this.allowHelpers,
        ...(options.environment === undefined
          ? {}
          : { extra: options.environment }),
        ...(askpass === undefined ? {} : { askpass }),
      },
      ...(signal === undefined ? {} : { signal }),
      ...(options.onMutationStarted === undefined
        ? {}
        : { onStarted: options.onMutationStarted }),
      ...(options.onProgress === undefined
        ? {}
        : {
            onStderrLine: (line: string) => {
              const percent = progressPercent(line);
              if (percent !== undefined) options.onProgress?.(percent);
            },
          }),
    });
  }

  async read(
    directory: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const output = await this.output(
      directory,
      args,
      Math.min(this.commandTimeoutMs, 15_000),
      signal,
    );
    if (output.status !== 0) throw commandError(output);
    return output.stdout;
  }

  /** One mutating command, reported into the operation that started it. */
  async mutate(
    context: RepositoryContext,
    args: readonly string[],
    operation: Operation,
    environment?: Readonly<Record<string, string>>,
  ): Promise<void> {
    const output = await this.output(
      context.repository,
      args,
      this.commandTimeoutMs,
      operation.controller.signal,
      {
        ...(environment === undefined ? {} : { environment }),
        onMutationStarted: () => {
          operation.mutationStarted = true;
        },
        onProgress: (percent) => {
          operation.progress = percent;
        },
      },
    );
    if (output.status !== 0) throw commandError(output);
  }

  /* ------------------------------ references ------------------------------ */

  async head(directory: string, signal?: AbortSignal): Promise<ExpectedState> {
    const branchOutput = await this.output(
      directory,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      Math.min(this.commandTimeoutMs, 15_000),
      signal,
    );
    let branch: string | null;
    if (branchOutput.status === 0) branch = oneLine(branchOutput.stdout);
    else if (branchOutput.status === 1) branch = null;
    else throw commandError(branchOutput);

    const output = await this.output(
      directory,
      ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      Math.min(this.commandTimeoutMs, 15_000),
      signal,
    );
    let headOid: string | null;
    if (output.status === 0) {
      const oid = oneLine(output.stdout);
      if (!validOid(oid)) throw malformed();
      headOid = oid;
    } else if (output.status === 1 && branch !== null) {
      headOid = null;
    } else {
      throw commandError(output);
    }
    return { headOid, branch };
  }

  async resolve(
    directory: string,
    reference: string,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.validateReference(directory, reference, signal);
    const output = await this.read(
      directory,
      ["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`],
      signal,
    );
    const oid = oneLine(output);
    if (!validOid(oid)) throw malformed();
    return oid;
  }

  /**
   * The name-shaped fields take `unknown` for the same reason
   * {@link validOid} does: a repository action is inspected here exactly as it
   * arrived, so a field the caller omitted has to refuse rather than throw.
   */
  async validateBranch(
    directory: string,
    name: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      typeof name !== "string" ||
      name === "" ||
      name.length > 255 ||
      name.startsWith("-") ||
      name.startsWith("refs/") ||
      name.includes("@{") ||
      hasControl(name)
    ) {
      throw badRequest("Branch name is invalid");
    }
    try {
      await this.read(
        directory,
        ["check-ref-format", "--branch", name],
        signal,
      );
    } catch {
      throw badRequest("Branch name is invalid");
    }
  }

  async validateReference(
    directory: string,
    reference: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    if (typeof reference !== "string") {
      throw badRequest("Git reference is invalid");
    }
    if (reference === "HEAD" || validOid(reference)) return;
    if (reference.startsWith("refs/")) {
      if (reference.length > 1024 || hasControl(reference)) {
        throw badRequest("Git reference is invalid");
      }
      try {
        await this.read(directory, ["check-ref-format", reference], signal);
      } catch {
        throw badRequest("Git reference is invalid");
      }
      return;
    }
    await this.validateBranch(directory, reference, signal);
  }

  async validateTagName(
    directory: string,
    name: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      typeof name !== "string" ||
      name === "" ||
      name.length > 255 ||
      name.startsWith("-") ||
      name.startsWith("refs/") ||
      name.includes("@{") ||
      hasControl(name)
    ) {
      throw badRequest("Tag name is invalid");
    }
    try {
      await this.read(
        directory,
        ["check-ref-format", `refs/tags/${name}`],
        signal,
      );
    } catch {
      throw badRequest("Tag name is invalid");
    }
  }

  /** A remote name that does not have to exist yet. */
  async validateRemoteName(
    directory: string,
    name: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      typeof name !== "string" ||
      name === "" ||
      name.length > 255 ||
      name.startsWith("-") ||
      name.includes(":") ||
      name.includes("/") ||
      hasControl(name)
    ) {
      throw badRequest("Git remote name is invalid");
    }
    try {
      await this.read(
        directory,
        ["check-ref-format", `refs/remotes/${name}/probe`],
        signal,
      );
    } catch {
      throw badRequest("Git remote name is invalid");
    }
  }

  async remotes(directory: string, signal?: AbortSignal): Promise<string[]> {
    const output = await this.read(directory, ["remote"], signal);
    return output
      .toString("utf8")
      .split("\n")
      .filter((line) => line !== "");
  }

  async validateRemote(
    directory: string,
    remote: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      typeof remote !== "string" ||
      remote === "" ||
      remote.length > 255 ||
      remote.startsWith("-") ||
      remote.includes(":") ||
      hasControl(remote) ||
      !(await this.remotes(directory, signal)).includes(remote)
    ) {
      throw badRequest("Select a configured Git remote");
    }
    try {
      await this.read(
        directory,
        ["check-ref-format", `refs/remotes/${remote}/probe`],
        signal,
      );
    } catch {
      throw badRequest("Git remote name is invalid");
    }
    await this.read(directory, ["remote", "get-url", "--", remote], signal);
  }

  async remoteTrackingOid(
    directory: string,
    remote: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const output = await this.output(
      directory,
      [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `refs/remotes/${remote}/${branch}^{commit}`,
      ],
      Math.min(this.commandTimeoutMs, 15_000),
      signal,
    );
    if (output.status === 0) {
      const oid = oneLine(output.stdout);
      if (!validOid(oid)) throw malformed();
      return oid;
    }
    if (output.status === 1) return null;
    throw commandError(output);
  }

  /** Every ref pointing at each commit, for the history page's decorations. */
  async commitRefs(
    directory: string,
    signal?: AbortSignal,
  ): Promise<Map<string, string[]>> {
    const output = await this.read(
      directory,
      [
        "for-each-ref",
        "--format=%(objectname)%00%(*objectname)%00%(refname)%00",
        "refs/heads/",
        "refs/remotes/",
        "refs/tags/",
      ],
      signal,
    );
    const refs = new Map<string, string[]>();
    for (const record of fieldsWithLf(output, 3)) {
      const oid =
        record[1] === "" ? (record[0] as string) : (record[1] as string);
      const existing = refs.get(oid) ?? [];
      existing.push(record[2] as string);
      refs.set(oid, existing);
    }
    return refs;
  }

  /* ------------------------------- operations ----------------------------- */

  register(operation: Operation, recovery: boolean): void {
    if (this.lifecycle.stopping) throw shuttingDown();
    const protectedIds = new Set(
      [...this.integrations.values()].map((owner) => owner.sessionId),
    );
    this.reserveSlot(protectedIds, recovery);
    this.order.push(operation.snapshot.id);
    this.operations.set(operation.snapshot.id, operation);
  }

  /**
   * Awaiting-integration records are capabilities referenced by live owners, so
   * they are kept until reconciliation releases the owner. Recovery keeps a
   * small bounded reserve so a full history can still be continued or aborted.
   */
  private reserveSlot(protectedIds: Set<string>, recovery: boolean): void {
    let index = 0;
    while (
      this.operations.size >= MAX_OPERATIONS &&
      index < this.order.length
    ) {
      const id = this.order[index] as string;
      const entry = this.operations.get(id);
      if (
        !protectedIds.has(id) &&
        entry !== undefined &&
        isTerminal(entry.snapshot.state)
      ) {
        this.order.splice(index, 1);
        this.operations.delete(id);
      } else {
        index += 1;
      }
    }
    const limit = MAX_OPERATIONS + (recovery ? 16 : 0);
    if (this.operations.size >= limit) {
      throw conflict("Too many active Git operations");
    }
  }

  entry(id: string): Operation | undefined {
    return this.operations.get(id);
  }

  operationSnapshot(id: string): OperationSnapshot {
    const operation = this.operations.get(id);
    if (operation === undefined) {
      throw notFoundOperation();
    }
    return readSnapshot(operation);
  }

  cancel(id: string): OperationSnapshot {
    const operation = this.operations.get(id);
    if (operation === undefined) throw notFoundOperation();
    if (!isTerminal(operation.snapshot.state)) {
      operation.snapshot = {
        ...operation.snapshot,
        cancellationRequested: true,
      };
      operation.controller.abort();
    }
    return readSnapshot(operation);
  }

  /**
   * This process's operation history for one checkout, newest first.
   *
   * The records are in memory and die with the core: a restarted core has an
   * empty queue by construction rather than by report.
   */
  async listOperations(
    workspaceRoot: string,
    requested: string,
  ): Promise<OperationSnapshot[]> {
    const context = await this.context(workspaceRoot, requested);
    const id = repositoryId(context);
    const snapshots: OperationSnapshot[] = [];
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const operation = this.operations.get(this.order[index] as string);
      if (operation === undefined) continue;
      if (
        operation.snapshot.repositoryId === id &&
        operation.snapshot.workspaceRoot === context.workspaceRoot
      ) {
        snapshots.push(readSnapshot(operation));
      }
    }
    return snapshots;
  }

  /** What this process still has in flight, across every workspace. */
  activeOperations(): { queued: number; running: number; ids: string[] } {
    let queued = 0;
    let running = 0;
    const ids: string[] = [];
    for (const id of this.order) {
      const operation = this.operations.get(id);
      if (operation === undefined) continue;
      if (operation.snapshot.state === "queued") queued += 1;
      else if (operation.snapshot.state === "running") running += 1;
      else continue;
      if (ids.length < 32) ids.push(id);
    }
    return { queued, running, ids };
  }

  finish(
    operation: Operation,
    state: OperationState,
    message: string | null,
  ): void {
    operation.snapshot = {
      ...operation.snapshot,
      state,
      message,
      finishedAt: nowRfc3339(),
    };
  }

  /** The lock a queued operation waits on, and the guard it then holds. */
  acquire(commonDir: string): Promise<() => void> {
    return this.lockFor(commonDir).acquire();
  }

  /**
   * Reject new commands, cancel queued and running operations, then wait for
   * every one of them to reach a terminal state.
   */
  async shutdown(timeoutMs: number): Promise<void> {
    this.lifecycle.stopping = true;
    this.stopping.abort();
    const operations = [...this.operations.values()];
    for (const operation of operations) {
      if (!isTerminal(operation.snapshot.state)) {
        operation.snapshot = {
          ...operation.snapshot,
          cancellationRequested: true,
        };
        operation.controller.abort();
      }
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const settled =
        this.lifecycle.activeGuards === 0 &&
        operations.every((operation) => isTerminal(operation.snapshot.state));
      if (settled) return;
      if (Date.now() > deadline) {
        throw internalError("Git shutdown did not finish before the deadline");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Lets a test start from a clean registry. */
  reset(): void {
    this.operations.clear();
    this.order.length = 0;
    this.integrations.clear();
    this.lifecycle.stopping = false;
    this.lifecycle.activeGuards = 0;
  }

  requireExecutionGrant(purpose: string): void {
    requireExecution(this.allowHelpers, purpose);
  }
}

/**
 * One entry as a caller reads it: the recorded snapshot with the live
 * percentage folded in.
 *
 * A settled operation reports 100 whichever number the command last printed.
 * `git` does not always finish on a round percentage, and a bar frozen at 97
 * beside a row that says "succeeded" is a worse lie than one that completes.
 */
export function readSnapshot(operation: Operation): OperationSnapshot {
  return {
    ...operation.snapshot,
    progress: isTerminal(operation.snapshot.state)
      ? 100
      : Math.min(operation.progress, 100),
  };
}

/**
 * Git's own phrasings for "the revision you named is not in this repository".
 *
 * A panel hands us an object ID or a ref name it read a moment ago; a branch
 * deleted or a history pruned in another window turns that into a git failure
 * which is not a core failure. Reporting 500 tells the user to file a bug for
 * a list they only need to refresh, so these answer 404 instead. Everything
 * else stays a 500: an unrecognised git failure is exactly the case where the
 * message must not be softened.
 */
const MISSING_REVISION = [
  "needed a single revision",
  "unknown revision or path not in the working tree",
  "could not get object info",
  "not a valid object name",
  "bad revision",
  "no such ref",
  "ambiguous argument",
];

export function commandError(output: CommandOutput): Error {
  const message = output.stderr.length === 0 ? output.stdout : output.stderr;
  const text = sanitizeRepository(message.toString("utf8"));
  const lowered = text.toLowerCase();
  if (MISSING_REVISION.some((phrase) => lowered.includes(phrase))) {
    return notFound(`Git could not resolve that revision: ${text}`);
  }
  return internalError(`Git operation failed: ${text}`);
}

export function notFoundOperation(): Error {
  return notFound("Git operation is unavailable");
}

function startsInside(parent: string, path: string): boolean {
  return contains(parent, path);
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
function hasControl(value: string): boolean {
  return CONTROL_CHARACTER.test(value);
}

/** Every action the queue may be asked to run, for the 404 message. */
export type { RepositoryAction };
