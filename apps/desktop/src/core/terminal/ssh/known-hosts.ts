/**
 * Host keys, scanned and then trusted by a person.
 *
 * Ported from the pre-merge implementation.
 *
 * `ssh` is never allowed to decide this. `StrictHostKeyChecking=yes` plus a
 * known_hosts file Armadra owns means an unknown or changed key fails the
 * connection instead of being accepted, prompted for on a TTY nobody is
 * watching, or written somewhere the user did not ask for.
 *
 * Three rules:
 *
 *  * **Armadra's own file.** Trust is written to `<data dir>/ssh/known_hosts`
 *    at 0600 and nowhere else. The user's `~/.ssh/known_hosts` is *read* — a
 *    host they already trust needs no second confirmation — but never written.
 *  * **Scan, show, confirm.** `ssh-keyscan` fetches the keys and `ssh-keygen
 *    -lf` derives the SHA-256 fingerprints; both are real binaries, so the
 *    fingerprint a person compares is the one OpenSSH computes. Nothing is
 *    stored until they say so.
 *  * **A changed key is a separate decision.** Replacing an existing entry is
 *    its own call with its own confirmation, because "the key changed" is
 *    either a reinstall or an attack and only the person knows which.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SshHost } from "../../settings/ssh-hosts";
import { hardenDirectory, writeSecret } from "../../paths";
import { unbracket } from "./argv";
import { runCommand } from "./run";

/**
 * Overrides `ssh-keyscan` for tests. Must be an absolute path; only the
 * program is substituted, so the arguments a scan really uses are exercised.
 */
export const KEYSCAN_OVERRIDE = "ARMADRA_SSH_KEYSCAN";

/**
 * The key types offered, newest first. Anything else `ssh-keyscan` might
 * return is ignored rather than trusted: this list is what the UI shows and
 * what the file may contain.
 */
const KEY_TYPES = "ed25519,ecdsa,rsa";

/**
 * How long a scan may take. A host that does not answer is not a host whose
 * key can be confirmed.
 */
const SCAN_TIMEOUT_MS = 10_000;

/** One key a host offered. */
export interface HostKey {
  /** `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`. */
  readonly keyType: string;
  /** `SHA256:…`, exactly as OpenSSH prints it. */
  readonly fingerprint: string;
  /**
   * The known_hosts line this would become. Sent to the client so the
   * confirmation names the same bytes that get written.
   */
  readonly line: string;
  /** This exact line is already trusted in a file Armadra reads. */
  readonly trusted: boolean;
}

/** What a scan found, and what is already on record. */
export interface HostKeyScan {
  readonly keys: readonly HostKey[];
  /**
   * A key is on record for this host but none of the scanned keys match it.
   * The connection will fail until somebody decides which is right.
   */
  readonly changed: boolean;
  /** The fingerprints currently trusted, so the UI can show old beside new. */
  readonly known: readonly string[];
}

/** Armadra's own trust file. Created 0600 on first write. */
export function armadraKnownHosts(dataDir: string): string {
  return join(dataDir, "ssh", "known_hosts");
}

/** The user's file, read but never written. */
function userKnownHosts(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.HOME === undefined || env.HOME === ""
    ? null
    : join(env.HOME, ".ssh", "known_hosts");
}

/**
 * The two `-o` options every `ssh` this core starts must carry.
 *
 * Returned as pairs rather than baked into one argv builder because the
 * terminal, the probe and the Worker all start `ssh` differently and all three
 * need exactly this.
 */
export function options(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const user = userKnownHosts(env);
  // Space separated, the way OpenSSH takes a list. A host the user already
  // trusts is not asked about again.
  const files =
    user === null
      ? armadraKnownHosts(dataDir)
      : `${armadraKnownHosts(dataDir)} ${user}`;
  return [
    "-o",
    `UserKnownHostsFile=${files}`,
    "-o",
    "StrictHostKeyChecking=yes",
  ];
}

/** The `[host]:port` form known_hosts uses for a non-default port. */
export function entryHost(host: SshHost): string {
  const address = unbracket(host.host);
  return host.port !== undefined && host.port !== 22
    ? `[${address}]:${host.port}`
    : address;
}

function keyscanProgram(env: NodeJS.ProcessEnv = process.env): string {
  return acceptedOverride(env[KEYSCAN_OVERRIDE]) ?? "ssh-keyscan";
}

/**
 * Only an absolute path with no whitespace replaces the program: a bare name
 * would resolve through `PATH`, and an argument smuggled through a space would
 * become part of the command line rather than part of the program name.
 *
 * Split out as a pure function so the rule can be tested without writing to
 * the process environment.
 */
export function acceptedOverride(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith("/") && !/\s/u.test(value) ? value : undefined;
}

/**
 * Whether a known_hosts line names `host`.
 *
 * The first field is a comma-separated list of patterns. Hashed entries
 * (`|1|…`) cannot be matched by name; they are left alone rather than guessed
 * at, which at worst asks for one extra confirmation.
 */
function namesHost(line: string, host: string): boolean {
  const patterns = line.trim().split(/\s+/u)[0];
  if (patterns === undefined) return false;
  return patterns.split(",").some((name) => name === host);
}

/** Fetch the keys a host offers and derive their fingerprints. */
export async function scan(
  dataDir: string,
  host: SshHost,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostKeyScan> {
  const argv = ["-T", "5", "-t", KEY_TYPES];
  if (host.port !== undefined) argv.push("-p", String(host.port));
  argv.push(unbracket(host.host));

  const scanned = await runCommand(keyscanProgram(env), argv, {
    timeoutMs: SCAN_TIMEOUT_MS,
  });
  if (scanned.timedOut) {
    throw new ScanFailed(503, "unavailable", "The host key scan timed out");
  }
  if (scanned.spawnError !== undefined) {
    throw new ScanFailed(
      500,
      "internal",
      `ssh-keyscan could not be started: ${scanned.spawnError}`,
    );
  }

  const known = trustedLines(dataDir, entryHost(host), env);
  const keys: HostKey[] = [];
  for (const raw of scanned.stdout.split("\n")) {
    const line = raw.trim();
    // `ssh-keyscan` writes `# comment` lines to stdout as well.
    if (line === "" || line.startsWith("#")) continue;
    const print = await fingerprint(dataDir, line);
    if (print === undefined) continue;
    keys.push({
      keyType: line.split(/\s+/u)[1] ?? "",
      fingerprint: print,
      trusted: known.some((entry) => entry === line),
      line,
    });
  }
  if (keys.length === 0) {
    throw new ScanFailed(
      503,
      "unavailable",
      "The host offered no key that could be read",
    );
  }
  const knownFingerprints: string[] = [];
  for (const line of known) {
    const print = await fingerprint(dataDir, line);
    if (print !== undefined) knownFingerprints.push(print);
  }
  return {
    keys,
    // A key is on record and the host is now offering a different one. That is
    // the case that must never be resolved automatically.
    changed: known.length > 0 && !keys.some((key) => key.trusted),
    known: knownFingerprints,
  };
}

/**
 * The SHA-256 fingerprint of one known_hosts line, via the real `ssh-keygen`.
 *
 * Computing it here would mean reimplementing OpenSSH's key encoding, and a
 * fingerprint a person compares against what their server prints has to be the
 * same function, not a lookalike.
 */
export async function fingerprint(
  dataDir: string,
  line: string,
): Promise<string | undefined> {
  // `ssh-keygen -lf` wants a file, and the key is not a secret, but the
  // directory still belongs to Armadra rather than to the system temp: a world
  // writable path is a place another process could swap the file between the
  // write and the read.
  const directory = join(dataDir, "ssh");
  const path = join(
    directory,
    `.fingerprint-${randomUUID().replace(/-/gu, "")}`,
  );
  try {
    mkdirSync(directory, { recursive: true });
    hardenDirectory(directory);
    writeSecret(path, `${line}\n`);
  } catch {
    return undefined;
  }
  try {
    const output = await runCommand("ssh-keygen", ["-l", "-f", path], {
      timeoutMs: SCAN_TIMEOUT_MS,
    });
    return output.stdout
      .split(/\s+/u)
      .find((field) => field.startsWith("SHA256:"));
  } finally {
    rmSync(path, { force: true });
  }
}

/** Every line in either file that names `host`. */
export function trustedLines(
  dataDir: string,
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const files = [armadraKnownHosts(dataDir)];
  const user = userKnownHosts(env);
  if (user !== null) files.push(user);
  const lines: string[] = [];
  for (const path of files) {
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const raw of contents.split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      if (namesHost(line, host)) lines.push(line);
    }
  }
  return lines;
}

/**
 * Write one scanned key into Armadra's own file.
 *
 * `replace` removes every existing entry for the host first, which is what a
 * changed key needs and what a first trust must not do silently — so the
 * caller has to pass it deliberately.
 */
export function trust(
  dataDir: string,
  host: SshHost,
  rawLine: string,
  replace: boolean,
): void {
  const entry = entryHost(host);
  const line = rawLine.trim();
  // Only a line for the host being confirmed, and only one line: a client that
  // echoed back something else must not be able to append arbitrary trust.
  if (line.split("\n").length !== 1 || !namesHost(line, entry)) {
    throw new ScanFailed(
      400,
      "bad_request",
      "That host key line does not belong to this host",
    );
  }
  const path = armadraKnownHosts(dataDir);
  const kept: string[] = [];
  for (const existing of readLines(path)) {
    const trimmed = existing.trim();
    if (trimmed === "") continue;
    if (namesHost(trimmed, entry) && (replace || trimmed === line)) continue;
    kept.push(existing);
  }
  kept.push(line);
  writeSecret(path, `${kept.join("\n")}\n`);
}

/** Forget every key Armadra holds for a host. */
export function forget(dataDir: string, host: SshHost): void {
  const entry = entryHost(host);
  const path = armadraKnownHosts(dataDir);
  const existing = readLines(path);
  if (existing === undefined) return;
  const kept = existing.filter(
    (line) => !namesHost(line, entry) && line.trim() !== "",
  );
  const contents = kept.join("\n");
  writeSecret(path, contents === "" ? "" : `${contents}\n`);
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }
}

/**
 * Whether `ssh` failed because the host's key changed. The message is
 * OpenSSH's, and recognising it is what turns a cryptic failure into the
 * replace-or-refuse decision the user actually has to make.
 */
export function identificationChanged(stderr: string): boolean {
  return stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED");
}

/**
 * A scan or trust failure carrying the status the API face owes it.
 *
 * The same shape `TerminalError` uses, declared here rather than imported so
 * this module has no dependency on the backend contract — it is used by the
 * settings routes as much as by the terminal.
 */
export class ScanFailed extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScanFailed";
  }
}
