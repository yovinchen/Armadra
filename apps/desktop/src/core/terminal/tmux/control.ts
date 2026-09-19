import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { internal } from "../backend";
import { asRecord, childEnvironment } from "../environment";

const run = promisify(execFile);

/**
 * The control channel: every `tmux` subcommand the backend issues.
 *
 * Every command goes through `tmux -u -S <data dir>/tmux.sock -f <data
 * dir>/tmux.conf`, so the core's sessions share nothing with the user's own
 * tmux server or `~/.tmux.conf`. The pane's process is a child of that server,
 * not of the core, which is the whole point: closing the app, or crashing it,
 * leaves the agent running and re-attachable.
 *
 * The socket is an absolute `-S <path>` and never a named `-L <name>`: a named
 * socket lands in a shared per-user directory under `TMPDIR`, where a second
 * build, a test run and the developer's own server all collide. Tests assert
 * this — see `tmux.test.ts`.
 */

/**
 * `#{window_activity}`, not `#{session_activity}`: tmux bumps
 * `session_activity` to `now` on every client **attach**, regardless of
 * whether the pane has produced any output. Using it as an idle judgement
 * would call a long-attached, silent session "just active" every time
 * something reattaches to it. `window_activity` only moves when the active
 * window's pane actually emits output.
 */
export const LIST_ALIVE_FORMAT =
  "#{session_name} #{session_attached} #{window_activity}";

/**
 * The tmux invocations issued by `paste`, broken out as a pure function so the
 * argument sequence can be asserted without a live tmux server.
 *
 * Two guards beyond the plain `load-buffer` / `paste-buffer` / `send-keys
 * Enter` sequence:
 *
 *   * `-r` on `paste-buffer` keeps `\n` as `\n` instead of rewriting it to
 *     `\r`;
 *   * the copy-mode exit (`send-keys -X cancel`) is gated by `if-shell -F
 *     '#{pane_in_mode}'` **inside the same tmux invocation** as
 *     `paste-buffer`, not a separate round trip beforehand: `paste-buffer -p`
 *     silently does nothing while the pane is in copy-mode, and a prior,
 *     separate exit call leaves a window where that state could still change
 *     before the paste itself runs.
 */
export function pastePlan(
  buffer: string,
  file: string,
  session: string,
  pressEnter: boolean,
): string[][] {
  const plan: string[][] = [
    ["load-buffer", "-b", buffer, file],
    [
      "if-shell",
      "-F",
      "#{pane_in_mode}",
      "send-keys -X cancel",
      ";",
      "paste-buffer",
      "-p",
      "-r",
      "-d",
      "-b",
      buffer,
      "-t",
      session,
    ],
  ];
  if (pressEnter) plan.push(["send-keys", "-t", session, "Enter"]);
  return plan;
}

/** One `list-sessions -F LIST_ALIVE_FORMAT` line. */
export function parseAliveLine(
  line: string,
  prefix: string,
): { name: string; attached: boolean } | undefined {
  const parts = line.split(/\s+/).filter(Boolean);
  const name = parts[0];
  if (name === undefined || !name.startsWith(prefix)) return undefined;
  return { name, attached: parts[1] !== undefined && parts[1] !== "0" };
}

export class TmuxControl {
  readonly socket: string;
  readonly conf: string;

  constructor(dataDir: string) {
    this.socket = join(dataDir, "tmux.sock");
    this.conf = join(dataDir, "tmux.conf");
  }

  /**
   * `-u` forces UTF-8 regardless of the core's locale: a GUI-launched process
   * often has no `LANG` at all, and tmux would then render every multi-byte
   * character — Chinese included — as `_`.
   */
  baseArgs(): string[] {
    return ["-u", "-S", this.socket, "-f", this.conf];
  }

  /**
   * The environment every tmux invocation runs with.
   *
   * The first command starts the server, and **the server keeps this
   * environment for every session it will ever create**, so this is not a
   * detail of one call: it is the environment of every shell the user will
   * open for as long as that server lives. Built, not inherited.
   */
  environment(): Record<string, string> {
    return asRecord(childEnvironment());
  }

  async run(args: readonly string[]): Promise<string> {
    try {
      const { stdout } = await run("tmux", [...this.baseArgs(), ...args], {
        env: this.environment(),
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8",
      });
      return stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      throw internal(`tmux failed: ${stderr.trim() || String(error)}`);
    }
  }

  /** Never throws: the caller wants a yes or a no, not an exception. */
  async tryRun(args: readonly string[]): Promise<string | undefined> {
    try {
      return await this.run(args);
    } catch {
      return undefined;
    }
  }

  async hasSession(name: string): Promise<boolean> {
    return (await this.tryRun(["has-session", "-t", name])) !== undefined;
  }

  /** `#{pane_in_mode}` — 1 while the pane is in copy-mode. */
  async paneInMode(name: string): Promise<boolean> {
    const output = await this.tryRun([
      "display",
      "-p",
      "-t",
      name,
      "#{pane_in_mode}",
    ]);
    return output?.trim() === "1";
  }

  async panePid(name: string): Promise<number | undefined> {
    const output = await this.tryRun([
      "display",
      "-p",
      "-t",
      name,
      "#{pane_pid} #{pane_current_command}",
    ]);
    const pid = Number.parseInt(output?.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isInteger(pid) ? pid : undefined;
  }

  async paneForeground(
    name: string,
  ): Promise<{ pid?: number; command?: string }> {
    const output =
      (await this.tryRun([
        "display",
        "-p",
        "-t",
        name,
        "#{pane_pid} #{pane_current_command}",
      ])) ?? "";
    const [first, ...rest] = output.trim().split(" ");
    const pid = Number.parseInt(first ?? "", 10);
    const command = rest.join(" ").trim();
    return {
      ...(Number.isInteger(pid) ? { pid } : {}),
      ...(command === "" ? {} : { command }),
    };
  }

  /**
   * `-H` takes hex, so arbitrary control bytes survive intact — no quoting
   * rules, no shell, no key-name parsing. Used only when nothing is attached;
   * an attached session gets the bytes through its client pty.
   */
  async sendKeysBytes(name: string, bytes: Buffer): Promise<void> {
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    await this.run(["send-keys", "-t", name, "-H", ...hex]);
  }

  /**
   * The `@armadra-runtime` server option, if a server is running and stamped.
   *
   * The name of the option is deliberately unchanged from the Rust Runtime's:
   * during the changeover both implementations talk to the same server on the
   * same socket, and a second option name would make each of them think the
   * other's server is unowned.
   */
  async serverOwner(): Promise<string | undefined> {
    const value = await this.tryRun([
      "show-options",
      "-s",
      "-v",
      "-q",
      "@armadra-runtime",
    ]);
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
  }

  /**
   * Claim the server for this process if nobody has yet. Called after every
   * `new-session`, which is the call that starts the server lazily.
   */
  async stampServer(fingerprint: string): Promise<void> {
    if ((await this.serverOwner()) !== undefined) return;
    await this.tryRun(["set-option", "-s", "@armadra-runtime", fingerprint]);
  }
}

/**
 * What started the tmux server: executable path plus version. Stored as a
 * server option so a later process can tell whether the server is its own.
 */
export function coreFingerprint(version: string): string {
  return `${process.execPath}@${version}`;
}
