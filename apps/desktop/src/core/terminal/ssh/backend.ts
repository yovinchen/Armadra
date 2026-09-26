/**
 * `SshBackend` — an SSH terminal is a normal session whose command is `ssh …`.
 *
 * ## Why this is a decorator and not a fourth backend
 *
 * The design's phase table names four backends (`tmux`, `direct`,
 * `sessionHost`, `ssh`), which reads as four implementations of
 * {@link TerminalBackend}. The Rust Runtime does not have one: the pre-merge implementation
 * builds `ssh_argv(&host)`, splits off argv[0] as the program, and hands the
 * rest to the *same* `SpawnRequest` a local terminal uses. The session that
 * results is a tmux session (or a direct pty) whose `backend_kind` is `tmux`,
 * running `ssh` as its command. There is no `SshBackend` in
 * the pre-merge implementation.
 *
 * Porting it as a fourth peer would therefore change behaviour in ways nothing
 * asked for: the row's `backend_kind` would become a fourth string the
 * front end and the reaper do not know, and a dropped connection would end the
 * session instead of leaving a live tmux pane with a dead `ssh` in it — which
 * is exactly the pane a person reconnects into.
 *
 * So `SshBackend` **is** a `TerminalBackend`, and satisfies the contract, by
 * wrapping the one underneath it and rewriting a single thing: `create`. It
 * substitutes the command and adds the askpass environment; everything else —
 * attach, input, resize, capture, terminate, capabilities — is the inner
 * backend's, unchanged and not re-exported through a copy. `kind` is the inner
 * backend's too, because the row has to say what is really behind the session.
 *
 * ## What the substitution is
 *
 * The argv comes from the **stored host**, never from the request. An unknown
 * host id is refused rather than silently falling back to a local shell: a
 * "remote" terminal that is quietly running on this machine is the one outcome
 * that must not happen.
 */

import type { SshHost } from "../../settings/ssh-hosts";
import {
  type AdoptableBackend,
  type Attachment,
  type BackendCapabilities,
  type BackendKind,
  type BackendNotice,
  type BackendRef,
  type ForegroundInfo,
  type SessionKey,
  type TerminalBackend,
  type TerminalHandle,
  type TerminalSize,
  type TerminalSpec,
  type TerminateMode,
  TerminalError,
  isAdoptable,
} from "../backend";
import { remoteShellCommand, sshArgv } from "./argv";
import type { AskpassService } from "./askpass";

/** Looks a host up in the settings registry. `undefined` when there is none. */
export type HostLookup = (hostId: string) => SshHost | undefined;

export interface SshBackendOptions {
  readonly dataDir: string;
  /** The backend that actually runs processes — `tmux` today. */
  readonly inner: TerminalBackend;
  readonly hosts: HostLookup;
  readonly askpass: AskpassService;
  /**
   * 画布 Agent 终端在远端 shell 里要带的环境（`remote/integration.ts`）：注入
   * 产物同步好之后答；不是 Agent 终端、主机没有 Worker 或同步失败时答
   * `undefined`，终端照常以登录 shell 打开。
   */
  readonly remote?: (
    hostId: string,
    env: readonly (readonly [string, string])[],
  ) => Promise<readonly (readonly [string, string])[] | undefined>;
}

/** 远端注入最多让终端等这么久；首次连接要探测 Node、握手并同步产物。 */
const REMOTE_PREPARE_TIMEOUT_MS = 30_000;

/**
 * The extra a caller attaches to a spec to say "this one goes over SSH".
 *
 * A separate interface rather than a field on {@link TerminalSpec} because
 * `TerminalSpec` belongs to R2a and the SSH host is not something the other
 * three backends have any use for. `create` accepts either.
 */
export interface SshTerminalSpec extends TerminalSpec {
  readonly sshHostId: string;
}

function isSshSpec(spec: TerminalSpec): spec is SshTerminalSpec {
  return typeof (spec as SshTerminalSpec).sshHostId === "string";
}

export class SshBackend implements TerminalBackend {
  constructor(private readonly options: SshBackendOptions) {}

  /** The row has to name what is really behind the session. */
  get kind(): BackendKind {
    return this.options.inner.kind;
  }

  /**
   * Rewrite the command, then create exactly as a local terminal would.
   *
   * A spec with no `sshHostId` passes straight through, so one backend can be
   * installed for every terminal rather than the manager having to choose.
   */
  async create(spec: TerminalSpec): Promise<TerminalHandle> {
    if (!isSshSpec(spec)) return await this.options.inner.create(spec);
    return await this.options.inner.create(await this.decorate(spec));
  }

  /**
   * What the inner backend is actually asked to run.
   *
   * Exported through a method rather than inlined so the argv and the
   * environment can be asserted without a tmux server: the substitution is the
   * whole of what this class does, and it is the part a test has to see.
   */
  async decorate(spec: SshTerminalSpec): Promise<TerminalSpec> {
    const host = this.options.hosts(spec.sshHostId);
    if (host === undefined) {
      throw new TerminalError(400, "bad_request", "Unknown SSH host");
    }
    const argv = sshArgv(this.options.dataDir, host);
    const program = argv.shift() as string;
    // Started lazily: a core whose user never opens an SSH terminal never
    // binds the askpass socket.
    await this.options.askpass.start();
    // A terminal has a real TTY, so `ssh` can prompt on it directly and the
    // helper is a fallback rather than the only path. It is still handed over
    // because a key passphrase for an agent-driven pane is a prompt nobody is
    // sitting in front of, and the dialog is where it can actually be answered.
    const askpass = this.options.askpass.childEnvironment(host.id) ?? [];
    const remoteEnv = await this.remoteEnvironment(spec);
    if (remoteEnv !== undefined && remoteEnv.length > 0) {
      argv.push(remoteShellCommand(remoteEnv));
    }
    return {
      ...spec,
      command: program,
      args: argv,
      env: [...spec.env, ...askpass],
    };
  }

  private async remoteEnvironment(
    spec: SshTerminalSpec,
  ): Promise<readonly (readonly [string, string])[] | undefined> {
    const prepare = this.options.remote;
    if (prepare === undefined) return undefined;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), REMOTE_PREPARE_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        prepare(spec.sshHostId, spec.env).catch(() => undefined),
        late,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /* ------------------------ everything else is the inner ------------------- */

  list(): Promise<BackendRef[]> {
    return this.options.inner.list();
  }

  attach(
    key: SessionKey,
    generation: number,
    size: TerminalSize,
  ): Promise<Attachment> {
    return this.options.inner.attach(key, generation, size);
  }

  detach(key: SessionKey, attachmentId: number): Promise<void> {
    return this.options.inner.detach(key, attachmentId);
  }

  input(key: SessionKey, bytes: Buffer): Promise<void> {
    return this.options.inner.input(key, bytes);
  }

  paste(key: SessionKey, text: string, pressEnter: boolean): Promise<void> {
    return this.options.inner.paste(key, text, pressEnter);
  }

  resize(key: SessionKey, size: TerminalSize): Promise<void> {
    return this.options.inner.resize(key, size);
  }

  capture(
    key: SessionKey,
    lines: number,
    withEscapes: boolean,
  ): Promise<string> {
    return this.options.inner.capture(key, lines, withEscapes);
  }

  signal(key: SessionKey, signal: "interrupt"): Promise<void> {
    return this.options.inner.signal(key, signal);
  }

  terminate(key: SessionKey, mode: TerminateMode): Promise<void> {
    return this.options.inner.terminate(key, mode);
  }

  getForeground(key: SessionKey): Promise<ForegroundInfo> {
    return this.options.inner.getForeground(key);
  }

  getCapabilities(): BackendCapabilities {
    return this.options.inner.getCapabilities();
  }

  scroll(key: SessionKey, lines: number): Promise<void> {
    return this.options.inner.scroll(key, lines);
  }

  destroyByReference(reference: string): Promise<void> {
    return this.options.inner.destroyByReference(reference);
  }

  setDormant(key: SessionKey, dormant: boolean): Promise<void> {
    return this.options.inner.setDormant(key, dormant);
  }

  notices(listener: (notice: BackendNotice) => void): void {
    this.options.inner.notices(listener);
  }

  snapshot(key: SessionKey): string | undefined {
    return this.options.inner.snapshot?.(key);
  }

  /**
   * Adoption is the inner backend's, and it has to travel through the wrapper.
   *
   * This class is what the manager holds, so a decorator that quietly did not
   * forward `adopt` would make the start-up reconciliation skip the backend
   * entirely — every surviving pane would be settled as `exited` instead of
   * re-adopted. A backend with nothing to adopt (there is none behind this one
   * today, but `direct` would be one) answers `undefined` rather than
   * pretending, exactly as `isAdoptable` describes.
   */
  adopt(
    key: SessionKey,
    reference: string,
    generation: number,
  ): Promise<number | undefined> {
    const inner = this.options.inner;
    if (!isAdoptable(inner)) return Promise.resolve(undefined);
    return inner.adopt(key, reference, generation);
  }

  detachAll(): Promise<void> {
    return this.options.inner.detachAll();
  }
}

/** The decorator claims `AdoptableBackend` only because it forwards `adopt`. */
export type SshDecorated = SshBackend & AdoptableBackend;
