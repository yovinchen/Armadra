/**
 * The `SSH_ASKPASS` helper, and the private socket it talks to.
 *
 * Ported from the pre-merge implementation, with one deliberate
 * change of transport that is written down here rather than left to be
 * rediscovered.
 *
 * `ssh` runs `$SSH_ASKPASS <prompt>` and reads one line from its stdout. On
 * the Rust side that helper is the Runtime's own executable in a second mode,
 * and it reaches the Runtime over the **shared loopback HTTP listener**, which
 * is why it needs a bearer token: without one, any local process could open a
 * dialog on the user's screen and read what they typed into it.
 *
 * The TypeScript core has no second mode to exec — it is `main.js` under a
 * `node` that a remote machine is not even guaranteed to have — so the helper
 * is a generated POSIX sh + `curl` script, the same shape R3's hook client
 * takes, and the endpoint is a **0600 unix socket of its own** rather than the
 * general HTTP surface. That is strictly narrower: file permissions already
 * restrict it to this user, and the askpass route no longer exists on a
 * listener anything else can reach. The one-time token stays, because file
 * permissions do not separate *this* `ssh` child from the user's other
 * processes.
 *
 * Three constraints the script inherits from the hook client, for the same
 * reasons:
 *
 *  * **The token is not on argv.** `ps` and `/proc/<pid>/cmdline` are globally
 *    readable, so it is handed to `curl` through `--config -` on stdin.
 *  * **The prompt is not on argv either.** Same document, same reason — plus
 *    it avoids `execve`'s argument-size limit for a prompt a server chose.
 *  * **One request, not a poll.** The Rust helper polls because it borrows a
 *    shared HTTP listener whose requests may not be held open. This socket is
 *    this service's own, so the request simply waits, and there is no interval
 *    at which an answer can be late.
 *
 * The helper prints the answer and exits 0, or exits non-zero with nothing on
 * stdout. Exiting non-zero is what makes `ssh` fail cleanly; printing a guess
 * would make it fail as an authentication error, which is a different and more
 * confusing thing to debug.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { hardenDirectory, hardenFile } from "../../paths";
import { PromptRegistry, type SshPrompt } from "./prompts";

/** What the helper needs to find this core, and what proves it may. */
export const SOCKET_ENV = "ARMADRA_ASKPASS_SOCKET";
export const TOKEN_ENV = "ARMADRA_ASKPASS_TOKEN";
/** Which host the prompt belongs to, so the dialog can name it. */
export const HOST_ENV = "ARMADRA_ASKPASS_HOST";

/**
 * How long the helper waits for a person. One second under the registry's own
 * expiry, so the helper is the one that gives up first and `ssh` sees a clean
 * failure rather than a truncated read.
 */
export const HELPER_WAIT_SECONDS = 119;

/** A minted token is good for one connection attempt and this long. */
const TOKEN_TTL_MS = 180_000;

/** The path `ssh` is pointed at, and the socket behind it. */
export function helperPath(dataDir: string): string {
  return join(dataDir, "ssh", "askpass");
}

export function socketPath(dataDir: string): string {
  return join(dataDir, "ssh", "askpass.sock");
}

/**
 * The `-o` options that let `ssh` ask at all.
 *
 * `BatchMode=no` re-enables prompting, and `NumberOfPasswordPrompts=1` keeps a
 * wrong answer from becoming three dialogs: one refusal is an answer, three is
 * an interrogation.
 */
export function askpassOptions(): string[] {
  return ["-o", "BatchMode=no", "-o", "NumberOfPasswordPrompts=1"];
}

/**
 * The environment an `ssh` child needs to reach the helper.
 *
 * `SSH_ASKPASS_REQUIRE=force` is what makes OpenSSH 8.4+ use the helper even
 * with no `DISPLAY`; older versions only consult `SSH_ASKPASS` when `DISPLAY`
 * is set, so a placeholder is provided for them. Neither is a display anybody
 * draws on — the dialog is in the Armadra client.
 */
export function environment(
  program: string,
  socket: string,
  token: string,
  hostId: string,
): [string, string][] {
  return [
    ["SSH_ASKPASS", program],
    ["SSH_ASKPASS_REQUIRE", "force"],
    ["DISPLAY", ":0"],
    [SOCKET_ENV, socket],
    [TOKEN_ENV, token],
    [HOST_ENV, hostId],
  ];
}

/**
 * Escaping for one value of a `curl --config` document.
 *
 * A quoted config value understands `\\` and `\"`, and nothing else — there is
 * no command substitution and no word splitting, which is the whole reason the
 * prompt travels this way. The prompt is not a secret (it is what the server
 * chose to display), so this is about a prompt containing a quote being read
 * correctly, not about injection; but a value that ended its own quoting could
 * add a `--output` line, so it is escaped rather than trusted.
 */
export function escapeConfigValue(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

/**
 * The generated helper.
 *
 * Rewritten on every start, the way the Rust wrapper is: the socket path and
 * this data directory can change between installs, and a stale script pointing
 * at a socket nothing listens on would silently stop working.
 *
 * `exec` so `curl`'s exit status is the helper's: `--fail` turns any non-2xx
 * answer into a non-zero exit with nothing on stdout, which is exactly the
 * "refuse cleanly" contract `ssh` needs.
 */
export function helperScript(socket: string): string {
  // The socket is baked in as well as passed in the environment: the
  // environment is what authorizes this call, and the literal is what a person
  // reading the file can see it talks to.
  return [
    "#!/bin/sh",
    "# Generated by Armadra. Asks the core for the secret 'ssh' is prompting",
    "# for. Not usable on its own: without the environment the core sets, the",
    "# request carries no token and the core refuses it.",
    `# socket: ${socket}`,
    "set -u",
    `if [ -z "\${${SOCKET_ENV}:-}" ] || [ -z "\${${TOKEN_ENV}:-}" ] || [ -z "\${${HOST_ENV}:-}" ]; then`,
    "  exit 1",
    "fi",
    '# Quoted curl-config values understand \\\\ and \\" and nothing else.',
    `prompt=$(printf '%s' "\${1:-}" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')`,
    "# The token and the prompt go in on stdin, never on argv: 'ps' and",
    "# /proc/<pid>/cmdline are globally readable.",
    `exec curl --silent --show-error --fail --max-time ${HELPER_WAIT_SECONDS} \\`,
    `  --unix-socket "\${${SOCKET_ENV}}" --config - <<ARMADRA_ASKPASS_END`,
    "--request POST",
    `--url "http://localhost${HELPER_ROUTE}"`,
    `--header "Authorization: Bearer \${${TOKEN_ENV}}"`,
    '--header "Content-Type: text/plain; charset=utf-8"',
    `--header "X-Armadra-Host: \${${HOST_ENV}}"`,
    '--data-raw "$prompt"',
    "ARMADRA_ASKPASS_END",
    "",
  ].join("\n");
}

/** The only path the private socket answers on. */
export const HELPER_ROUTE = "/askpass";

/** What a helper request turned into, for the caller that wants to watch. */
export type PromptListener = (prompt: SshPrompt) => void;

export interface AskpassOptions {
  readonly dataDir: string;
  /** Where an opened prompt is announced, so the page can show a dialog. */
  readonly onPrompt: PromptListener;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * The service: one unix socket, one token set, one prompt registry.
 *
 * Started lazily. A core whose user never configures an SSH host never binds
 * anything, and a platform with no unix sockets never tries.
 */
export class AskpassService {
  readonly prompts = new PromptRegistry();
  private readonly tokens = new Map<string, number>();
  private server: Server | undefined;
  private started = false;

  constructor(private readonly options: AskpassOptions) {}

  /**
   * Bind the socket and write the helper, once.
   *
   * Windows has neither a unix socket nor a `sh` to run the helper, so the
   * service does not start there and {@link childEnvironment} hands back
   * nothing — `ssh` then fails on a host that needs a password rather than
   * hanging on a helper that cannot answer.
   *
   * TODO(R6): the Windows path is a named pipe plus a `.cmd` helper calling
   * the bundled `curl.exe`, alongside the session-host work that brings the
   * rest of the Windows terminal story up.
   */
  async start(): Promise<void> {
    if (this.started || process.platform === "win32") return;
    this.started = true;
    const directory = join(this.options.dataDir, "ssh");
    mkdirSync(directory, { recursive: true });
    hardenDirectory(directory);

    const path = socketPath(this.options.dataDir);
    // A socket left behind by a core that was killed would refuse the bind;
    // removing it is safe because this path is inside a 0700 directory only
    // this user can reach.
    rmSync(path, { force: true });

    const server = createServer((request, response) => {
      void this.serve(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ path }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // 0600 as soon as it exists. The bind honours the umask, which on a
    // permissive one would leave the socket group- or world-connectable.
    hardenFile(path);
    this.server = server;

    writeHelper(helperPath(this.options.dataDir), helperScript(path));
  }

  /**
   * The environment for one `ssh` child, or `undefined` when prompts are not
   * available. A fresh token each time: it authorizes one connection attempt's
   * helper and nothing else.
   */
  childEnvironment(hostId: string): [string, string][] | undefined {
    if (this.server === undefined) return undefined;
    return environment(
      helperPath(this.options.dataDir),
      socketPath(this.options.dataDir),
      this.mint(),
      hostId,
    );
  }

  /** One-time, short-lived, and spent on first use. */
  mint(): string {
    this.sweep();
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(token, Date.now() + TOKEN_TTL_MS);
    return token;
  }

  /**
   * Constant-time, and spends the token.
   *
   * A `Map.has` would leak nothing useful here — the key is 256 bits of
   * randomness — but the comparison is written this way because the next
   * person to add a shorter credential should find the safe shape already in
   * place.
   */
  private spend(presented: string): boolean {
    this.sweep();
    for (const [token, expiry] of this.tokens) {
      if (token.length !== presented.length) continue;
      if (
        !timingSafeEqual(Buffer.from(token), Buffer.from(presented)) ||
        expiry <= Date.now()
      ) {
        continue;
      }
      this.tokens.delete(token);
      return true;
    }
    return false;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, expiry] of [...this.tokens]) {
      if (expiry <= now) this.tokens.delete(token);
    }
  }

  private async serve(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    const refuse = (status: number): void => {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end();
    };
    if (request.method !== "POST" || request.url !== HELPER_ROUTE) {
      refuse(404);
      return;
    }
    const authorization = request.headers.authorization ?? "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    const hostId = header(request.headers["x-armadra-host"]);
    if (token === "" || hostId === "" || !this.spend(token)) {
      // Not started by this core, or a token already spent. Refusing is the
      // only safe answer: nothing here may prompt on somebody else's behalf.
      refuse(401);
      return;
    }
    let prompt: string;
    try {
      prompt = await readBody(request);
    } catch {
      refuse(400);
      return;
    }

    const opened = this.prompts.open(hostId, prompt);
    this.options.onPrompt(opened);
    // One second under the registry's own expiry, so the answer path and the
    // giving-up path cannot race.
    const answer = await this.prompts.await(
      opened.promptId,
      HELPER_WAIT_SECONDS * 1_000,
    );
    if (answer === undefined) {
      this.prompts.close(opened.promptId);
      // 504, so `curl --fail` exits non-zero and `ssh` fails rather than
      // reading an empty line as an empty password.
      refuse(504);
      return;
    }
    // The secret is on this response body and nowhere else — not argv, not a
    // file, not a log. One trailing newline, which is what `ssh` reads.
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`${answer}\n`);
  }

  async stop(): Promise<void> {
    this.tokens.clear();
    const server = this.server;
    this.server = undefined;
    this.started = false;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(socketPath(this.options.dataDir), { force: true });
  }
}

function header(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * The prompt is a short string a server chose. A ceiling keeps a helper that
 * is not ours from making the core hold an arbitrary buffer.
 */
const MAX_PROMPT_BYTES = 8 * 1024;

async function readBody(
  request: import("node:http").IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_PROMPT_BYTES) throw new Error("prompt too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 0700 from the moment it exists.
 *
 * Not `writeSecret`: that primitive is for 0600 data, and this file has to be
 * executable by `ssh`. The shape is otherwise the same — mode at open time,
 * because `writeFile(path, data, { mode })` creates the file before the mode
 * is honoured on some platforms.
 */
export function writeHelper(path: string, contents: string): void {
  rmSync(path, { force: true });
  const handle = openSync(path, "wx", 0o700);
  try {
    writeSync(handle, Buffer.from(contents, "utf8"));
  } finally {
    closeSync(handle);
  }
  // The umask can still have cleared bits from the requested mode.
  if (process.platform !== "win32") chmodSync(path, 0o700);
}
